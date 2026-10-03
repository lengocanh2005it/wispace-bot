import { consoleRedactedLogger } from '../logging/redacted-logger';
import { errorMessage } from '../masking/error-message';
import { loadVaultSecrets, type VaultApplication } from '../secrets';
import { validateInternalApiKeyEnv } from './internal-api-key-env';
import { getPostgresSsl } from './postgres-ssl';

/** One configuration value the application would refuse to start on. */
export interface StartupViolation {
  /** The env key an operator has to change, or the shared scope it belongs to. */
  scope: string;
  /** The fail-closed constraint's own message, redacted and length-capped. */
  message: string;
}

export type StartupEnv = Record<string, string | undefined>;

interface StartupProbe {
  scope: string;
  run: (env: StartupEnv) => void;
}

const COMMON_PROBES: readonly StartupProbe[] = [
  {
    scope: 'INTERNAL_API_KEY',
    run: (env) => {
      validateInternalApiKeyEnv(env);
    },
  },
  {
    scope: 'DB_SSL',
    run: (env) => {
      getPostgresSsl((key) => env[key]);
    },
  },
];

/**
 * Evaluate the shared fail-closed constraints and report every offender.
 *
 * Each probe is independent, so one bad key never hides the next — the point
 * of the deploy-time startup validation phase (#1499) is a single pass, not one
 * failing key per deploy attempt. This reaches no database, no Redis and no
 * vendor API, which is why it runs before the release container starts.
 */
export function collectCommonStartupViolations(
  env: StartupEnv,
): StartupViolation[] {
  const violations: StartupViolation[] = [];

  for (const probe of COMMON_PROBES) {
    try {
      probe.run(env);
    } catch (error) {
      violations.push({ scope: probe.scope, message: errorMessage(error) });
    }
  }

  return violations;
}

/**
 * Print every violation, naming the key an operator has to change, and return
 * the process exit code the deploy phase gates on. Each message is already
 * redacted by the collector that produced it, and this writer adds the shared
 * runtime-secret redaction on top.
 */
export function reportStartupViolations(
  violations: readonly StartupViolation[],
): number {
  if (violations.length === 0) {
    consoleRedactedLogger.log('Startup validation passed.');
    return 0;
  }

  for (const violation of violations) {
    consoleRedactedLogger.error(
      `ERROR: startup validation: ${violation.scope}: ${violation.message}`,
    );
  }
  consoleRedactedLogger.error(
    `ERROR: startup validation found ${violations.length} offending key(s) — refusing to deploy (#1499)`,
  );
  return 1;
}

export interface StartupValidationRunnerOptions {
  /** Which Vault path set supplies this app's runtime secrets. */
  application: VaultApplication;
  /** Collect every constraint violation from the resolved environment. */
  collect: (env: StartupEnv) => StartupViolation[];
  /** Test seam; defaults to the real Vault loader. */
  loadSecrets?: (options: { application: VaultApplication }) => Promise<void>;
}

/**
 * Build the deploy-time startup validation entry point for one app (#1499).
 *
 * Vault has to load first: the values being judged are Vault-delivered and are
 * deliberately absent from the container's bootstrap environment, so the check
 * cannot run before it.
 */
export function createStartupValidationRunner(
  options: StartupValidationRunnerOptions,
): () => Promise<number> {
  const loadSecrets = options.loadSecrets ?? loadVaultSecrets;

  return async (): Promise<number> => {
    try {
      await loadSecrets({ application: options.application });
    } catch (error) {
      consoleRedactedLogger.error(
        `ERROR: startup validation could not load Vault secrets: ${errorMessage(error)}`,
      );
      return 1;
    }

    return reportStartupViolations(options.collect(process.env));
  };
}
