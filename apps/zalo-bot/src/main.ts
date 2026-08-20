import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { errorMessage, sanitizeErrorStack } from '@wispace/bot-common';
import { AppModule } from './app.module';

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
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  const corsOrigin = process.env.CORS_ORIGIN?.trim();
  if (corsOrigin) {
    app.enableCors({ origin: corsOrigin.split(',') });
  }

  app.use(helmet());
  app.useBodyParser('json', { limit: '256kb' });
  app.setGlobalPrefix('v1', { exclude: ['health', 'health/*path', 'metrics'] });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
  );

  app.enableShutdownHooks();

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT') ?? 3002;
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
