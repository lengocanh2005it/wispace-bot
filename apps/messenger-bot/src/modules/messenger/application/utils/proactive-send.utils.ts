import { isMessenger24hWindowError } from '../messages/chat-delivery.messages';

/** L2: cron/proactive Send bị Meta 24h — caller skip, không retry. */
export class ProactiveMessenger24hSkippedError extends Error {
  constructor(
    readonly psid: string,
    readonly messageType: string,
  ) {
    super('Messenger 24h messaging window');
    this.name = 'ProactiveMessenger24hSkippedError';
  }
}

/** L2: proactive Send (cron báo cáo, nhắc lịch) — không retry khi Meta 24h. */
export function isProactiveMessenger24hError(error: unknown): boolean {
  return isMessenger24hWindowError(error);
}

export function buildProactiveFailureMessageType(
  baseMessageType: string,
): string {
  return `${baseMessageType}_MESSENGER_24H`;
}

export function buildProactive24hLogErrorMessage(): string {
  return 'Meta 24h messaging window (#10) — user has not messaged bot recently';
}
