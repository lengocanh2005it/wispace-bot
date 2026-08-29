import { Module } from '@nestjs/common';
import { BotCommonModule } from '@wispace/bot-common/guard';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { WebActivityController } from './presentation/controllers/web-activity.controller';

@Module({
  imports: [BotCommonModule, DatabaseModule],
  controllers: [WebActivityController],
})
export class WebActivityModule {}
