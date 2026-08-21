# Design: Observability — #290 + #302

## Scope

| Issue | Title | Status |
|-------|-------|--------|
| #290 | Wire Discord/Zalo chat metrics into Prometheus | In scope |
| #302 | Define per-bot SLOs and RED/cost/backlog alerts | In scope (core only) |

## #290: Wire Discord/Zalo chat metrics

### Problem

`PlatformAgentService` for Discord and Zalo falls through to `NOOP_METRICS_PORT`. LLM latency, tool calls, round outcomes, and chat step metrics are silently dropped. Messenger has full metrics; Discord/Zalo have none.

### Fix

Mirror Messenger's pattern:
1. Each bot creates `MetricsService extends BotMetricsService` with platform prefix.
2. Each bot creates `MetricsModule` exporting the service.
3. Wire `metrics` adapter into `PlatformAgentService` factory.
4. Expose `/metrics` endpoint (Prometheus scrape).

### Files changed

**Discord:**
- `apps/discord-bot/src/modules/metrics/metrics.service.ts` — **new** (prefix: `discord`)
- `apps/discord-bot/src/modules/metrics/metrics.module.ts` — **new**
- `apps/discord-bot/src/modules/discord-chat/discord-chat.module.ts` — wire metrics into agent factory
- `apps/discord-bot/src/app.module.ts` — import MetricsModule + expose /metrics

**Zalo:**
- `apps/zalo-bot/src/modules/metrics/metrics.service.ts` — **new** (prefix: `zalo`)
- `apps/zalo-bot/src/modules/metrics/metrics.module.ts` — **new**
- `apps/zalo-bot/src/modules/zalo-chat/zalo-chat.module.ts` — wire metrics into agent factory
- `apps/zalo-bot/src/app.module.ts` — import MetricsModule + expose /metrics

## #302: Define per-bot SLOs and alerts (core)

### Problem

`alert.rules.yml` has only 3 basic rules. No SLO definitions, no RED alerts for chat latency/error rate.

### Fix

Add threshold-based SLO alerts using histograms already collected by `BotMetricsService`:
- **Chat availability:** `1 - rate(chat_step_duration_seconds{status="error"}[5m]) / rate(chat_step_duration_seconds[5m]) < 0.99`
- **LLM latency p95:** `histogram_quantile(0.95, rate(llm_call_duration_seconds_bucket[5m])) > 30`
- **LLM error rate:** `rate(llm_round_outcome_total{outcome="error"}[5m]) / rate(llm_round_outcome_total[5m]) > 0.05`

### Files changed

- `deploy/monitoring/alert.rules.yml` — add SLO alert rules

## What does NOT change

- `BotMetricsService` (shared) — no changes, already supports all platforms.
- Messenger metrics — unchanged, already wired.
