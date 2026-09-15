import { ConfigService } from '@nestjs/config';
import { bootstrapBot } from '@wispace/bot-common/bootstrap';
import { AppModule } from './app.module';

void bootstrapBot({
  appModule: AppModule,
  application: 'zalo',
  rawBody: true,
  port: (app) => app.get(ConfigService).get<number>('PORT') ?? 3002,
  configurePlatform: (app) => {
    const corsOrigin = process.env.CORS_ORIGIN?.trim();
    if (corsOrigin) {
      app.enableCors({ origin: corsOrigin.split(',') });
    }
    app.useBodyParser('json', { limit: '256kb' });
  },
});
