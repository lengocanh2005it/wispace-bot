import './shared/common/tracing'; // MUST be first — initialises OTel SDK before any module loads
import { shutdownTracing } from './shared/common/tracing';
// vps-self-pull-deploy smoke test: no-op, verifies end-to-end self-pull deploy
import { bootstrapBot } from '@wispace/bot-common/bootstrap';
import { AppModule } from './app.module';
import { parseJsonBodyLimit } from './shared/config/body-limit';

void bootstrapBot({
  appModule: AppModule,
  application: 'messenger',
  rawBody: true,
  port: () => process.env.PORT ?? 3000,
  configurePlatform: (app) => {
    const bodyLimit = parseJsonBodyLimit(process.env.HTTP_JSON_BODY_LIMIT);
    app.useBodyParser('json', { limit: bodyLimit });
    app.useBodyParser('urlencoded', { limit: bodyLimit, extended: true });
  },
  shutdownTracing,
  loggerName: 'Shutdown',
});
