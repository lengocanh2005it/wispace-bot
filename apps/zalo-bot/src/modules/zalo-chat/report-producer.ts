import type { BackgroundProducerProbe } from '@wispace/llm-agent/execution';

/**
 * The background producers whose concurrency this app pins by configuration.
 *
 * Empty on purpose: every Zalo background producer derives its concurrency from
 * the LLM admission capacity, and a derived value can never exceed the capacity
 * it comes from, so there is no stored value to go stale.
 */
export const ZALO_BACKGROUND_PRODUCERS: readonly BackgroundProducerProbe[] = [];
