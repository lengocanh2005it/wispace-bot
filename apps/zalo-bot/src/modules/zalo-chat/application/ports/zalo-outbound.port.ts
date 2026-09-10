import type { OutboundDeliveryOutcome } from '@wispace/contracts';

export interface ZaloOutboundOptions {
  skipDeadLetter?: boolean;
  deliveryKey?: string;
  clarification?: boolean;
  deadLetterOn?: 'all' | 'ambiguous' | 'none';
  retryOn?: 'all' | 'none';
  userId?: number;
  units?: number;
  skipRateLimit?: boolean;
  signal?: AbortSignal;
}

export interface ZaloOutboundPort {
  sendText(
    zaloUserId: string,
    text: string,
    options?: ZaloOutboundOptions,
  ): Promise<OutboundDeliveryOutcome>;
  sendTextForRetry(
    zaloUserId: string,
    text: string,
    deliveryKey: string,
    signal?: AbortSignal,
  ): Promise<OutboundDeliveryOutcome>;
  isAmbiguousDeliveryError(error: unknown): boolean;
}

export const ZALO_OUTBOUND = Symbol('ZALO_OUTBOUND');
