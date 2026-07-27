import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

const logger = new Logger('Bootstrap');

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
  app.enableCors({
    origin: '*',
  });
  await app.listen(process.env.PORT ?? 3001);
}
void bootstrap();
