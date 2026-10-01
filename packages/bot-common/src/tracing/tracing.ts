/**
 * OpenTelemetry SDK bootstrap — MUST be started before any other module loads.
 * Sends traces via OTLP HTTP when OTEL_EXPORTER_OTLP_ENDPOINT is set
 * (no exporter = spans are no-ops, safe on deployments without a collector).
 *
 * The service name is a parameter, not a constant: each bot reports under its
 * own name so spans from the three bots stay distinguishable in a collector.
 * This module registers no signal handlers — process exit ordering is owned
 * by the bootstrap (`bootstrapBot`), which calls `shutdownTracing`.
 */
import { Logger } from '@nestjs/common';
import {
  context,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { errorMessage } from '../masking';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { SEMRESATTRS_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

let activeSdk: NodeSDK | undefined;

/** Start the SDK and remember it, so a bare `shutdownTracing()` can flush it. */
export function startTracing(serviceName: string): void {
  if (activeSdk) return;
  // Read here, not at module load: the fail-open branch is the one the
  // Discord and Zalo ports will copy, and reading it here keeps it testable.
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [SEMRESATTRS_SERVICE_NAME]: serviceName,
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
  activeSdk = sdk;
}

const TRACING_LOGGER = new Logger('Tracing');
// Bounded so a stalled exporter flush can never hold the graceful-shutdown
// drain hostage — the bootstrap owns exit ordering and calls this after
// app.close().
const TRACING_SHUTDOWN_TIMEOUT_MS = 5_000;

export interface TracingShutdownOptions {
  shutdown?: () => Promise<unknown>;
  logger?: { log(message: string): void; warn(message: string): void };
  timeoutMs?: number;
}

/**
 * Run `fn` inside a root span, so every downstream span — WISPACE client
 * calls, LLM rounds, DB queries — nests under one trace id instead of each
 * starting its own. No-op when tracing is not configured.
 *
 * Attributes are the caller's to choose and are the caller's privacy call:
 * learner and delivery identifiers belong in logs, not in span attributes
 * (#859). Prefer lengths, features, and outcomes.
 */
export async function withRootSpan<T>(
  tracerName: string,
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer: Tracer = trace.getTracer(tracerName);
  const span = tracer.startSpan(name);
  if (Object.keys(attributes).length > 0) span.setAttributes(attributes);
  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: errorMessage(err),
      });
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Flush OTel spans without ever throwing or hanging the caller (#511).
 */
export async function shutdownTracing(
  opts: TracingShutdownOptions = {},
): Promise<void> {
  const {
    shutdown = () => activeSdk?.shutdown() ?? Promise.resolve(),
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
