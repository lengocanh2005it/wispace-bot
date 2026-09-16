import {
  Logger,
  ValidationPipe,
  type LoggerService,
  type Type,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import {
  collectRuntimeSecretValues,
  registerRuntimeSecrets,
  errorMessage,
  sanitizeErrorStack,
} from '../masking';
import { RedactedLogger } from '../logging';
import { loadVaultSecrets, type VaultApplication } from '../secrets';

export const DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 45_000;

export type ShutdownSignal = 'SIGTERM' | 'SIGINT';
export type BootstrapLogger = Pick<LoggerService, 'log' | 'error'>;
export type BotPort = string | number;
export type BotPortResolver =
  | BotPort
  | ((app: NestExpressApplication) => BotPort | Promise<BotPort>);

export interface ShutdownDeps {
  app: { close: () => Promise<void> };
  shutdownTracing?: () => Promise<void>;
  timeoutMs: number;
  logger: BootstrapLogger;
  exit: (code: number) => void;
}

export interface BootstrapBotOptions {
  appModule: Type<unknown>;
  application: VaultApplication;
  port: BotPortResolver;
  rawBody?: boolean;
  configurePlatform?: (app: NestExpressApplication) => void | Promise<void>;
  shutdownTracing?: () => Promise<void>;
  loggerName?: string;
  logger?: BootstrapLogger;
  shutdownTimeoutMs?: number;
  exit?: (code: number) => void;
}

let processErrorHandlersInstalled = false;

function formatError(err: unknown): [string, unknown?] {
  return [
    `Error during graceful shutdown: ${errorMessage(err)}`,
    err instanceof Error ? sanitizeErrorStack(err.stack) : undefined,
  ];
}

export function installProcessErrorHandlers(
  logger: BootstrapLogger,
  exit: (code: number) => void,
): void {
  if (processErrorHandlersInstalled) return;

  process.on('unhandledRejection', (reason) => {
    logger.error(
      `Unhandled rejection: ${errorMessage(reason)}`,
      reason instanceof Error ? sanitizeErrorStack(reason.stack) : undefined,
    );
  });

  process.on('uncaughtException', (error) => {
    logger.error(
      `Uncaught exception: ${errorMessage(error)}`,
      sanitizeErrorStack(error.stack),
    );
    exit(1);
  });

  processErrorHandlersInstalled = true;
}

export function resetProcessErrorHandlersForTests(): void {
  processErrorHandlersInstalled = false;
}

export function createShutdownHandler(deps: ShutdownDeps) {
  const hasShutdownTracing = deps.shutdownTracing !== undefined;
  const {
    app,
    shutdownTracing = async () => {},
    timeoutMs,
    logger,
    exit,
  } = deps;
  let shuttingDown = false;
  let exited = false;

  return (signal: ShutdownSignal): void => {
    if (shuttingDown) {
      logger.log(`Already shutting down, ignoring ${signal}`);
      return;
    }
    shuttingDown = true;

    void (async () => {
      logger.log(`Received ${signal}, starting graceful shutdown…`);

      const forceExitTimeout = setTimeout(() => {
        if (exited) return;
        exited = true;
        logger.error(
          `Graceful shutdown timed out after ${timeoutMs}ms, forcing exit`,
        );
        exit(1);
      }, timeoutMs);
      forceExitTimeout.unref();

      try {
        await app.close();
        logger.log('Graceful shutdown completed');
      } catch (err) {
        logger.error(...formatError(err));
      }

      try {
        await shutdownTracing();
        if (hasShutdownTracing) {
          logger.log('Tracing shutdown completed');
        }
      } catch (err) {
        logger.error(...formatError(err));
      } finally {
        clearTimeout(forceExitTimeout);
        if (!exited) {
          exited = true;
          exit(0);
        }
      }
    })();
  };
}

export async function bootstrapBot(
  options: BootstrapBotOptions,
): Promise<void> {
  const logger =
    options.logger ?? new Logger(options.loggerName ?? 'Bootstrap');
  const exit = options.exit ?? ((code: number) => process.exit(code));

  installProcessErrorHandlers(logger, exit);

  await loadVaultSecrets({ application: options.application });

  // Keep this registration after Vault loading and before Nest module init so
  // all model-context boundaries see the complete runtime-secret registry.
  const runtimeSecretCount = registerRuntimeSecrets(
    collectRuntimeSecretValues((key) => process.env[key]),
  );
  logger.log(`Registered ${runtimeSecretCount} runtime secrets`);

  const app = await NestFactory.create<NestExpressApplication>(
    options.appModule,
    {
      rawBody: options.rawBody,
      logger: new RedactedLogger(),
    },
  );

  await options.configurePlatform?.(app);

  app.use(helmet());
  app.setGlobalPrefix('v1', { exclude: ['health', 'health/*path', 'metrics'] });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
  );
  app.enableShutdownHooks();

  const port =
    typeof options.port === 'function' ? await options.port(app) : options.port;
  await app.listen(port);
  logger.log(`Application listening on port ${port}`);

  const shutdown = createShutdownHandler({
    app,
    shutdownTracing: options.shutdownTracing,
    timeoutMs:
      options.shutdownTimeoutMs ?? DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
    logger,
    exit,
  });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
