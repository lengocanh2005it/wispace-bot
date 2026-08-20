import './tracing'; // MUST be first — initialises OTel SDK before any module loads
// vps-self-pull-deploy smoke test: no-op, verifies end-to-end self-pull deploy
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { errorMessage, sanitizeErrorStack } from '@wispace/bot-common';
import { AppModule } from './app.module';
import { parseJsonBodyLimit } from './shared/config/body-limit';

const SHUTDOWN_LOGGER = new Logger('Shutdown');
// Must cover the longest in-flight work (LLM tool execution can take 35s)
// plus drain time for the debounce chat queue.
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 45_000;

process.on('unhandledRejection', (reason) => {
  SHUTDOWN_LOGGER.error(
    `Unhandled rejection: ${errorMessage(reason)}`,
    reason instanceof Error ? sanitizeErrorStack(reason.stack) : undefined,
  );
});

process.on('uncaughtException', (error) => {
  SHUTDOWN_LOGGER.error(
    `Uncaught exception: ${errorMessage(error)}`,
    sanitizeErrorStack(error.stack),
  );
  process.exit(1);
});

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  const bodyLimit = parseJsonBodyLimit(process.env.HTTP_JSON_BODY_LIMIT);
  app.useBodyParser('json', { limit: bodyLimit });
  app.useBodyParser('urlencoded', { limit: bodyLimit, extended: true });

  app.use(helmet());
  app.setGlobalPrefix('v1', { exclude: ['health', 'health/*path', 'metrics'] });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
  );

  app.enableShutdownHooks();

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  SHUTDOWN_LOGGER.log(`Application listening on port ${port}`);

  const shutdown = async (signal: string) => {
    SHUTDOWN_LOGGER.log(`Received ${signal}, starting graceful shutdown…`);

    const forceExitTimeout = setTimeout(() => {
      SHUTDOWN_LOGGER.error(
        `Graceful shutdown timed out after ${GRACEFUL_SHUTDOWN_TIMEOUT_MS}ms, forcing exit`,
      );
      process.exit(1);
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    forceExitTimeout.unref();

    try {
      await app.close();
      SHUTDOWN_LOGGER.log('Graceful shutdown completed');
    } catch (err) {
      SHUTDOWN_LOGGER.error(
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
