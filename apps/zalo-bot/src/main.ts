import { ConfigService } from '@nestjs/config';
// The bare side-effect import must stay separate from the named import below:
// it initialises the OTel SDK before any module loads, and merging the two
// would drop that ordering guarantee.
import './shared/tracing'; // MUST be first — initialises OTel SDK before any module loads
import { shutdownTracing } from '@wispace/bot-common/tracing';
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
  shutdownTracing,
});
