import {
  readEnvBoolean,
  readOptionalPositiveInt,
  type StartupEnv,
  type StartupViolation,
} from '@wispace/bot-common/config';
import { errorMessage } from '@wispace/bot-common/masking';
import { createLlmProviderAdapterFromEnv } from '../provider/from-env.factory';
import { resolveBackgroundProducerConcurrency } from './background-admission-capacity';
import { buildLlmExecutionConfig } from './llm-execution.config';

/** One background producer whose concurrency can be pinned by configuration. */
export interface BackgroundProducerProbe {
  producerName: string;
  concurrencyEnvKey: string;
}

/**
 * Evaluate the fail-closed LLM constraints and report every offender in one
 * pass (#1499). A producer with no configured concurrency can never exceed the
 * capacity — it derives from it — so only pinned producers need a probe.
 */
export function collectLlmStartupViolations(
  env: StartupEnv,
  producers: readonly BackgroundProducerProbe[],
): StartupViolation[] {
  const get = <T>(key: string): T | undefined => env[key] as T | undefined;
  const violations: StartupViolation[] = [];

  // The execution config comes first because the provider factory builds it too:
  // an unusable value would otherwise surface under the provider's scope as a
  // second, misleading offender for one cause. Capacity also derives from it,
  // so a producer cannot be judged without it.
  let executionConfig: ReturnType<typeof buildLlmExecutionConfig>;
  try {
    executionConfig = buildLlmExecutionConfig(get);
  } catch (error) {
    // Today the only throwing constraint inside the builder is the attempt
    // budget, and its own message names the key — scoping the group keeps a
    // future constraint from being filed under the wrong key.
    violations.push({
      scope: 'LLM execution configuration',
      message: errorMessage(error),
    });
    return violations;
  }

  try {
    createLlmProviderAdapterFromEnv(get);
  } catch (error) {
    violations.push({
      scope: 'LLM provider configuration',
      message: errorMessage(error),
    });
  }

  if (
    executionConfig.globalConcurrencyEnabled &&
    !readEnvBoolean({ get }, 'REDIS_ENABLED', false)
  ) {
    violations.push({
      scope: 'LLM_GLOBAL_CONCURRENCY_ENABLED',
      message:
        'LLM_GLOBAL_CONCURRENCY_ENABLED=true requires a Redis client — refusing to start with the aggregate limit silently bypassed (#389)',
    });
  }

  for (const producer of producers) {
    try {
      resolveBackgroundProducerConcurrency(executionConfig, {
        enabled: executionConfig.enabled,
        producerName: producer.producerName,
        configuredConcurrency: readOptionalPositiveInt(
          get,
          producer.concurrencyEnvKey,
        ),
        // The application warns instead of failing when execution is disabled;
        // startup validation mirrors that rather than reporting a refused start.
        onWarning: () => {},
      });
    } catch (error) {
      violations.push({
        scope: producer.concurrencyEnvKey,
        message: errorMessage(error),
      });
    }
  }

  return violations;
}
