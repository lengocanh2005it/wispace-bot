import { Module } from '@nestjs/common';
import { BotCommonModule } from '@wispace/bot-common/guard';
import { ZaloChatModule } from '../zalo-chat/zalo-chat.module';
import { ZaloLinkCompletionService } from './application/services/zalo-link-completion.service';
import { ZaloLinkReconcileCronService } from './application/services/zalo-link-reconcile-cron.service';
import { ZaloRelinkNotifier } from './application/services/zalo-relink-notifier.service';
import { ZaloOauthController } from './presentation/controllers/zalo-oauth.controller';
import { ZaloOauthModule } from './zalo-oauth.module';

/** HTTP composition boundary for OAuth; keeps the OAuth domain independent of chat. */
@Module({
  imports: [BotCommonModule, ZaloOauthModule, ZaloChatModule],
  controllers: [ZaloOauthController],
  providers: [
    ZaloLinkCompletionService,
    ZaloRelinkNotifier,
    ZaloLinkReconcileCronService,
  ],
  exports: [ZaloOauthModule],
})
export class ZaloOauthHttpModule {}
