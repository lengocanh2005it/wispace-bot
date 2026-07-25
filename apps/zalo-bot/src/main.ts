import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  app.enableCors({ origin: '*' });
  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT') ?? 3002;
  await app.listen(port);
}
void bootstrap();
