import type { StageResult } from '@wispace/reschedule-confirm';
import type { MessengerRichFollowUp } from '../../domain/entities/messenger-rich-message.types';

export interface MessengerStageResult extends StageResult {
  richFollowUp: MessengerRichFollowUp;
}
