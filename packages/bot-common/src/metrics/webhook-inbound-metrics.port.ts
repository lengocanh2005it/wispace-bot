/** Per-bot registry metrics for shared webhook-inbound processing. */
export interface WebhookInboundMetricsPort {
  incWebhookInboundRetentionDeleted(count: number): void;
  incWebhookInboundInlineAttempt(platform: string, outcome: string): void;
  observeWebhookInboundDispatchLag(
    platform: string,
    trigger: string,
    seconds: number,
  ): void;
}
