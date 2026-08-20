import { MessengerMessageLog } from '../entities/messenger.types';

export const MESSENGER_MESSAGE_LOG_REPOSITORY = Symbol(
  'MESSENGER_MESSAGE_LOG_REPOSITORY',
);

export interface MessengerMessageLogRepositoryPort {
  logMessage(params: {
    userId?: number;
    psid?: string;
    messageType: string;
    status: 'SENT' | 'FAILED';
    errorMessage?: string;
  }): Promise<MessengerMessageLog>;
  countMessageLogsByTypeSince(
    messageType: string,
    since: Date,
  ): Promise<number>;
  deleteMessageLogsOlderThan(cutoff: Date): Promise<number>;
}
