import { bootstrapBot } from '@wispace/bot-common/bootstrap';
import { AppModule } from './app.module';

void bootstrapBot({
  appModule: AppModule,
  application: 'discord',
  port: () => process.env.PORT ?? 3001,
  configurePlatform: (app) => {
    const corsOrigin = process.env.CORS_ORIGIN?.trim();
    if (corsOrigin) {
      app.enableCors({ origin: corsOrigin.split(',') });
    }
  },
});
