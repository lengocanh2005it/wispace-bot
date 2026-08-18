import type { BurstReservationResult } from '@wispace/chat-metering';

export const CHAT_BURST_COUNTER = Symbol('CHAT_BURST_COUNTER');

export interface ChatBurstCounterPort {
  getBurstCount(psid: string): Promise<number>;
  /**
   * Atomically increment the burst counter and check against the limit.
   * Returns allowed=false (and does NOT increment) when already at or above limit.
   * Callers must call releaseReservation() if the downstream DB reserve later fails.
   */
  tryReserveBurst(psid: string, limit: number): Promise<BurstReservationResult>;
  releaseReservation(psid: string): Promise<void>;
}
