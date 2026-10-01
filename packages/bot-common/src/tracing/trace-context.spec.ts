import { context, propagation, SpanKind, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  captureTraceContext,
  withExtractedTraceContext,
  withRootSpan,
} from './tracing';

describe('trace context propagation', () => {
  // The default NoopContextManager cannot hold an active context across an
  // await, which is exactly the case this module exists for. And without a
  // registered provider, startSpan returns a NonRecordingSpan whose trace id is
  // 32 zeroes, which captureTraceContext is right to reject. Both are installed
  // here so the test exercises the real path.
  beforeAll(() => {
    context.setGlobalContextManager(
      new AsyncLocalStorageContextManager().enable(),
    );
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
      }) as unknown as Parameters<typeof trace.setGlobalTracerProvider>[0],
    );
    // startTracing installs this in production; these specs cover propagation
    // without starting the SDK, so they install it themselves.
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  });
  afterAll(() => {
    context.disable();
    trace.disable();
    propagation.disable();
  });

  it('carries a request trace id onto work that runs after the request', async () => {
    const seen: string[] = [];

    // Stand-in for the request span, then the flush that happens after it.
    const requestSpan = trace.getTracer('test').startSpan('request', {
      kind: SpanKind.SERVER,
    });
    const requestTraceId = requestSpan.spanContext().traceId;

    const carried = await context.with(
      trace.setSpan(context.active(), requestSpan),
      async () => {
        const value = captureTraceContext();
        requestSpan.end();
        return value;
      },
    );
    expect(carried).toBeDefined();

    // Deliberately outside the request's context: the debounce means the
    // flush runs with no active span, so the trace id can only arrive through
    // the carrier. If extraction were skipped the seen id would be the new
    // span's own, not the request's.
    expect(trace.getSpan(context.active())).toBeUndefined();
    await withExtractedTraceContext(carried, async () => {
      seen.push(trace.getSpan(context.active())!.spanContext().traceId);
    });

    // The child ran after the parent span had already ended, which is the
    // whole point: the debounce means the LLM turn outlives the request.
    expect(seen).toEqual([requestTraceId]);
  });

  it('starts a fresh trace when the carrier is missing or malformed', async () => {
    await withExtractedTraceContext(undefined, async () => {
      expect(trace.getSpan(context.active())).toBeUndefined();
    });
    // A malformed carrier must not resurrect the caller's own span: extract
    // finds no traceparent and yields an empty context, so the flush starts a
    // fresh trace rather than attributing work to an unrelated one.
    await withExtractedTraceContext('not-a-traceparent', async () => {
      expect(trace.getSpan(context.active())).toBeUndefined();
    });
  });

  it('captures nothing when no span is active', () => {
    expect(captureTraceContext()).toBeUndefined();
  });

  it('rethrows so the flush path logs the failure once', async () => {
    await expect(
      withRootSpan('test', 'root', { a: 'b' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
