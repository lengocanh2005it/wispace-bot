import type { BackgroundProducerProbe } from '@wispace/llm-agent/execution';

/**
 * The report producer's pinned concurrency.
 *
 * The report cron and the deploy-time startup validation read this same
 * descriptor, so the preflight cannot disagree with the value the running
 * process applies. Producers that derive their concurrency from the admission
 * capacity are absent from the list on purpose: derived means they can never
 * exceed the capacity they come from, so there is no stored value to go stale.
 */
export const MESSENGER_REPORT_PRODUCER: BackgroundProducerProbe = {
  producerName: 'messenger report',
  concurrencyEnvKey: 'REPORT_SEND_CONCURRENCY',
};

export const MESSENGER_BACKGROUND_PRODUCERS: readonly BackgroundProducerProbe[] =
  [MESSENGER_REPORT_PRODUCER];
