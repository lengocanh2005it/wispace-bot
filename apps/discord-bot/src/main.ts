import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { errorMessage, sanitizeErrorStack } from '@wispace/bot-common/masking';
import {
  collectRuntimeSecretValues,
  registerRuntimeSecrets,
} from '@wispace/llm-agent';
import { AppModule } from './app.module';
import { loadVaultSecrets } from './shared/config/vault-secrets';

const logger = new Logger('Bootstrap');
// Must cover the longest in-flight work (LLM tool execution can take 35s)
// plus drain time for the debounce chat queue.
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 45_000;

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
  process.exit(1);
});

async function bootstrap() {
  await loadVaultSecrets();

  // No-secrets-in-model-context invariant (#632): register the process's
  // known secret values so every model-context boundary can redact them.
  const runtimeSecretCount = registerRuntimeSecrets(
    collectRuntimeSecretValues((key) => process.env[key]),
  );
  logger.log(`Registered ${runtimeSecretCount} runtime secrets`);

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const corsOrigin = process.env.CORS_ORIGIN?.trim();
  if (corsOrigin) {
    app.enableCors({ origin: corsOrigin.split(',') });
  }

  app.use(helmet());
  app.setGlobalPrefix('v1', { exclude: ['health', 'health/*path', 'metrics'] });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
  );

  app.enableShutdownHooks();

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  logger.log(`Application listening on port ${port}`);

  const shutdown = async (signal: string) => {
    logger.log(`Received ${signal}, starting graceful shutdown…`);

    const forceExitTimeout = setTimeout(() => {
      logger.error(
        `Graceful shutdown timed out after ${GRACEFUL_SHUTDOWN_TIMEOUT_MS}ms, forcing exit`,
      );
      process.exit(1);
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    forceExitTimeout.unref();

    try {
      await app.close();
      logger.log('Graceful shutdown completed');
    } catch (err) {
      logger.error(
        `Error during graceful shutdown: ${errorMessage(err)}`,
        err instanceof Error ? sanitizeErrorStack(err.stack) : undefined,
      );
    } finally {
      clearTimeout(forceExitTimeout);
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
void bootstrap();
