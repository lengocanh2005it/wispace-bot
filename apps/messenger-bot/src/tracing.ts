/**
 * OpenTelemetry SDK bootstrap — MUST be imported before any other module.
 * Sends traces via OTLP HTTP when OTEL_EXPORTER_OTLP_ENDPOINT is set
 * (no exporter = spans are no-ops, safe on deployments without a collector).
 */
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

process.on('SIGTERM', () => {
  void sdk.shutdown().finally(() => process.exit(0));
});
