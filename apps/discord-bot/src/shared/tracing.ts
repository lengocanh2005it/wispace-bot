/**
 * Composition root for tracing — the OTel SDK itself lives in
 * `@wispace/bot-common/tracing` (#1457). This file exists only so the SDK
 * starts as a *side-effect of an import*, which is the ordering that
 * instrumentation requires: `startTracing()` called from top-level code in
 * main.ts would run after the imports above it were already evaluated.
 *
 * The service name must equal the tracer name `createMetricsModule('discord',
 * 'discord-bot')` passes to `trace.getTracer`, so spans from BotMetricsService
 * and the SDK's own resource land under one service. That string is also
 * written in apps/discord-bot/src/app.module.ts — change one, and spans
 * silently split across two service names.
 */
import { startTracing } from '@wispace/bot-common/tracing';

startTracing('discord-bot');
