import { Module } from '@nestjs/common';
import { ZaloChatModule } from '../zalo-chat/zalo-chat.module';
import { ZaloOauthController } from './presentation/controllers/zalo-oauth.controller';
import { ZaloOauthModule } from './zalo-oauth.module';

/** HTTP composition boundary for OAuth; keeps the OAuth domain independent of chat. */
@Module({
  imports: [ZaloOauthModule, ZaloChatModule],
  controllers: [ZaloOauthController],
})
export class ZaloOauthHttpModule {}
