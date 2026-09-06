/**
 * OpenTelemetry SDK bootstrap — MUST be imported before any other module.
 * Sends traces via OTLP HTTP when OTEL_EXPORTER_OTLP_ENDPOINT is set
 * (no exporter = spans are no-ops, safe on deployments without a collector).
 */
import { Logger } from '@nestjs/common';
import { errorMessage } from '@wispace/bot-common/masking';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { SEMRESATTRS_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [SEMRESATTRS_SERVICE_NAME]: 'messenger-ai-for-student',
  }),
  traceExporter: otlpEndpoint
    ? new OTLPTraceExporter({ url: otlpEndpoint })
    : undefined,
  instrumentations: [
    new HttpInstrumentation({ ignoreIncomingRequestHook: () => false }),
    new PgInstrumentation(),
  ],
});

sdk.start();

const TRACING_LOGGER = new Logger('Tracing');
// Bounded so a stalled exporter flush can never hold the graceful-shutdown
// drain hostage — main.ts owns exit ordering and calls this after app.close().
const TRACING_SHUTDOWN_TIMEOUT_MS = 5_000;

export interface TracingShutdownOptions {
  shutdown?: () => Promise<unknown>;
  logger?: { log(message: string): void; warn(message: string): void };
  timeoutMs?: number;
}

/**
 * Flush OTel spans without ever throwing or hanging the caller (#511).
 * Process exit ordering is owned by main.ts — this module registers no
 * signal handlers of its own.
 */
export async function shutdownTracing(
  opts: TracingShutdownOptions = {},
): Promise<void> {
  const {
    shutdown = () => sdk.shutdown(),
    logger = TRACING_LOGGER,
    timeoutMs = TRACING_SHUTDOWN_TIMEOUT_MS,
  } = opts;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      shutdown(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`OTel SDK shutdown timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    logger.log('OTel SDK shutdown completed');
  } catch (err) {
    logger.warn(
      `OTel SDK shutdown failed, continuing shutdown: ${errorMessage(err)}`,
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
