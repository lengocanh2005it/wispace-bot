export const WEBHOOK_DEDUPE_STORE = Symbol('WEBHOOK_DEDUPE_STORE');

export interface WebhookDedupeStorePort {
  /** Returns true when the message mid was already processed recently. */
  isDuplicateMessageMid(mid: string, psid: string): Promise<boolean>;
  /** Returns true when the same postback was already processed recently. */
  isDuplicatePostback(psid: string, payload: string): Promise<boolean>;
  /**
   * Forget a message mid so a later dead-letter replay can re-process it.
   * Called when the original processing failed and the event was dead-lettered.
   */
  forgetMessageMid(mid: string, psid: string): Promise<void>;
}
