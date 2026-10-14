/**
 * Composition root for tracing — the OTel SDK itself lives in
 * `@wispace/bot-common/tracing` (#1457). This file exists only so the SDK
 * starts as a *side-effect of an import*, which is the ordering that
 * instrumentation requires: `startTracing()` called from top-level code in
 * main.ts would run after the imports above it were already evaluated.
 *
 * The service name comes from BOT_SERVICE_NAMES so it stays equal to the one
 * `createMetricsModule('zalo', ...)` passes to `trace.getTracer`.
 */
import { startTracing, BOT_SERVICE_NAMES } from '@wispace/bot-common/tracing';

startTracing(BOT_SERVICE_NAMES.zalo);
