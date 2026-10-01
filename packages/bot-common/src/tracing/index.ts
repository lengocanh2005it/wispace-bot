export {
  startTracing,
  shutdownTracing,
  withRootSpan,
  type TracingShutdownOptions,
} from './tracing';

/**
 * The three service names, used both for the SDK resource and for the tracer
 * name handed to `createMetricsModule`. They must be the same string on both
 * sides or spans split across two services, which is why they live here
 * instead of being written out per app.
 */
export const BOT_SERVICE_NAMES = {
  messenger: 'messenger-ai-for-student',
  discord: 'discord-bot',
  zalo: 'zalo-bot',
} as const;
