import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';

const logger = new Logger('Bootstrap');
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000;

process.on('unhandledRejection', (reason) => {
  logger.error(
    `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
    reason instanceof Error ? reason.stack : undefined,
  );
});

process.on('uncaughtException', (error) => {
  logger.error(`Uncaught exception: ${error.message}`, error.stack);
  process.exit(1);
});

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const corsOrigin = process.env.CORS_ORIGIN?.trim();
  if (corsOrigin) {
    // credentials: true — the account-link pending capability rides an
    // HttpOnly cookie from the cross-origin frontend (fetch credentials:'include')
    app.enableCors({
      origin: corsOrigin.split(','),
      credentials: true,
    });
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
      logger.error('Error during graceful shutdown', err);
    } finally {
      clearTimeout(forceExitTimeout);
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
void bootstrap();
