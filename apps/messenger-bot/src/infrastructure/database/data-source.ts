import 'reflect-metadata';
import {
  buildCliDataSource,
  SHARED_ENTITIES,
  WebActivityEntity,
} from '@wispace/database';
import {
  ChatDailyUsageEntity,
  ChatIdempotencyEntity,
  LlmSafetyEventEntity,
  LlmUsageEventEntity,
} from '@wispace/chat-metering';
import { StudyReminderJobEntity } from '@wispace/study-reminder-shared';
import { ChatQuotaEventEntity } from './entities/chat-quota-event.entity';
import { MessageLogEntity } from './entities/message-log.entity';

export default buildCliDataSource([
  ...SHARED_ENTITIES,
  MessageLogEntity,
  ChatDailyUsageEntity,
  ChatQuotaEventEntity,
  LlmUsageEventEntity,
  LlmSafetyEventEntity,
  ChatIdempotencyEntity,
  StudyReminderJobEntity,
  WebActivityEntity,
]);
