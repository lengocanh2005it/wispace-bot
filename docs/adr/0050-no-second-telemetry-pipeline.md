---
status: accepted
---

# No second telemetry pipeline: keep OpenTelemetry + Prometheus, reject `@nestjs/observe`

Evaluated on 2026-09-28 in [#1456](https://github.com/lengocanh2005it/wispace-bot/issues/1456)
and recorded here so the decision survives the issue being closed. messenger-bot
already runs the OpenTelemetry SDK (OTLP HTTP + HTTP/Pg instrumentation,
`packages/bot-common/src/tracing/tracing.ts`, started from
`apps/messenger-bot/src/shared/common/tracing.ts`), `bot-metrics` exposes
Prometheus metrics, `ops-health` provides alerting, and the deploy stack runs
Alertmanager. `@nestjs/observe` is the official NestJS APM agent, but adopting it
would add a second telemetry pipeline without closing a gap, would ship learner
and delivery telemetry off-estate, and is a 0.x package (0.3.2) that will break.
No code changes.

## The "provider-neutral" claim is untested, and that is the load-bearing correction

[#1456](https://github.com/lengocanh2005it/wispace-bot/issues/1456) justified the
choice with "the provider-neutral stance the OpenTelemetry bootstrap exists to
preserve". That stance is currently **unproven**. No OTel collector is deployed:
`OTEL_EXPORTER_OTLP_ENDPOINT` appears in no `.env.example`, and
`deploy/monitoring/` contains only Prometheus and Alertmanager — no Tempo,
Jaeger, Zipkin, or Grafana. Tracing is therefore a fail-open no-op in every
environment we have evidence for, including production.

OTel removes vendor lock-in at the *API* layer, not at the *backend* layer. When
a collector is finally deployed we will still pick a backend — Tempo, Grafana
Cloud, Honeycomb, an APM SaaS — out of cost and supportability, and that choice
will be made with no data. "Provider-neutral" is a reason to prefer OTel over a
vendor agent as an *instrumentation* choice, which is a real but small reason.
The reason we actually keep OTel is that **it is already built and it is cheap**:
the SDK is installed, fail-open by design, and sharing it costs one import once
#1457 moves it to `@wispace/bot-common`. Recording the real reason matters: if a
future reader treats "provider-neutral" as a validated property of the estate,
they will size the collector decision assuming a neutral backend is waiting.

## No consumer reads traces, so #1458/#1459 are preparedness, not a gap

The question #1456 never asked is who reads a trace. Nothing in this
repository does: there is no collector, no Tempo/Grafana/trace UI, and no
Prometheus or Alertmanager rule that consumes spans. Prometheus and
Alertmanager already answer "is the fleet up"; a trace answers a different
question — "why did *this* request fail" — and nothing is currently asking it.

After #1458/#1459 all three bots will emit spans into nothing. That is
acceptable and cheap, but it must be named as what it is: **infrastructure
staged ahead of a need**, chosen because it costs one import and cannot fail
startup, not because a known operational question is blocked on it. The
distinction matters when someone later evaluates whether tracing is "working" —
empty span output is the designed behaviour here, not a regression.

## Consequences

- **The first reconsider-condition in #1456 cannot fire.** It required "a
  collector is deployed and its operation becomes an on-call burden", but no
  collector exists and nothing in the repository plans one. A trigger gated
  on an absent precondition is not a safety net; it is decoration. It is left
  in the closed issue as written, because the issue is historical, and
  corrected here so nobody treats it as live.
- **The second condition is the only live trigger**, and it is a one-shot, not
  a periodic review: Discord/Zalo tracing (#1458/#1459) lands and shows a
  question the existing stack cannot answer. After that fires once, the correct
  next step is a decision about reading traces, not a recurring re-evaluation of
  `@nestjs/observe`.
- Deploying a collector while nothing reads traces is operating cost for a gap.
  Whether to *expose* traces is a separate question from whether to *emit*
  them, and this ADR settles only the latter.
- Until a collector exists, span volume is irrelevant — three bots emitting
  no-op spans cost nothing and produce nothing. #1458/#1459 are safe to land now.
