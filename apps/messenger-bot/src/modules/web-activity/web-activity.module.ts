import { Module } from '@nestjs/common';
import { BotCommonModule } from '@wispace/bot-common/guard';
import { WebActivityService } from '@wispace/database';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { WEB_ACTIVITY_WRITER } from './domain/web-activity-writer.port';
import { WebActivityController } from './presentation/controllers/web-activity.controller';

@Module({
  imports: [BotCommonModule, DatabaseModule],
  controllers: [WebActivityController],
  providers: [
    { provide: WEB_ACTIVITY_WRITER, useExisting: WebActivityService },
  ],
})
export class WebActivityModule {}
