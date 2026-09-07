# SLO catalog & error-budget policy

Owner: the repo maintainer. This is the source of truth for what the fleet
commits to and what happens when it burns the difference. Alert routing on the
resulting severities is #683; the external deadman is #515.

## Scope

Three learner journeys the bots own end-to-end. Every SLI below is computed
from metrics the services already emit — no new instrumentation beyond the
delivery counters added with this catalog (#829).

## The catalog

| # | Journey | SLI (event + good-event) | SLO target | Window | Error budget | Data source |
| - | ------- | ------------------------ | ---------- | ------ | ------------ | ----------- |
| 1 | Chat reply | one completed chat-pipeline flush (`chat_total` step), receipt → outbound send | availability ≥ 99%; p95 latency ≤ 30s | rolling 28d | ≤ 1% of steps error; p95 over 30s for 5m pages | `{platform}_chat_step_duration_seconds{step="chat_total",status}` (all 3 bots since #371) |
| 2 | Morning report delivery | one scheduled-report send attempt reaching a terminal delivery outcome | ≥ 99% delivered | rolling 28d | ≤ 1% terminal delivery failures | `{platform}_report_delivery_total{status="sent\|failed"}` (new, #829) |
| 3 | Study-reminder delivery | one reminder dispatch reaching a terminal outcome (sent vs failed; cancelled/suppressed excluded) | ≥ 99% delivered | rolling 28d | ≤ 1% terminal dispatch failures | `{platform}_reminder_dispatch_total{status="sent\|failed"}` (Messenger since #684; Discord/Zalo wired with #829) |

Notes:

- **Chat reply excludes nothing** — the `chat_total` step spans the whole
  pipeline including LLM calls. The LLM provider is a tracked **dependency
  SLI**, measured separately by `LlmLatencyHigh` / `LlmErrorRateHigh`
  (`{platform}_llm_call_duration_seconds`); provider incidents show up in the
  chat SLO too, which is intended — learners feel both.
- **Report/reminder "failed" is terminal only**: rate-limited and permanent
  delivery failures count; deferred retries, window-closed, and skips do not
  (the eventual terminal outcome counts). Crash-recovery short-circuits count
  as `sent` — the delivery record proves the learner received the report.
- **Targets are initial commitments, not measurements.** There is no 28-day
  baseline yet. Review after 30 days of data and revise once; until then treat
  a breach as "the signal is new", not "we regressed".

## Error-budget policy

Burn rate = observed error ratio ÷ (1 − SLO target). Multi-window,
two-sided (a fast burn must be confirmed by its short window to page).

| Condition | Meaning | Action |
| --------- | ------- | ------ |
| burn rate > 14.4× over 1h, confirmed > 14.4× over 5m | >2% of the 28d budget gone in one hour | **Page** (`severity: critical`, `SloBurnFast*` alerts) |
| burn rate > 3× over 6h, confirmed > 3× over 30m | slow bleed | **Ticket** (`severity: warning`, `SloBurnSlow*` alerts) — investigate within business hours |
| budget exhausted (28d error ratio > 1%) | the commitment is broken | **Feature freeze on that journey** (below) |

### Freeze rules

- **Invoke:** the maintainer, after a fast-burn page on the journey or on
  discovering the 28d budget is exhausted. The freeze is scoped to the affected
  journey (chat / report / reminder), not the whole fleet.
- **What freezes:** new feature work touching that journey's code paths.
  Reliability work, bug fixes, and the alerting plane itself take priority.
- **Lift:** when the 28d burn is back under 50% of the budget consumed, or the maintainer
  overrides with a written reason in the incident thread (an override is
  allowed — the budget is a forcing function, not a suicide pact).
- **Authority today:** single-maintainer fleet — the maintainer is the only
  role that can invoke or lift. When #834 (on-call rotation) lands, this
  section must be updated to match its escalation policy.

## Where the alerts live

`deploy/monitoring/alert.rules.yml` group `slo-burn`: recording rules
(`sli:*:error_ratio:*`) + fast/slow burn alerts per journey, evaluated from
those records. Synthetic promtool tests in
`deploy/monitoring/tests/alert.rules.test.yml` pin breach, confirm-window, and
no-traffic silence for each.

## Ops commands

```bash
# current 28d error ratios (query raw counters in Prometheus — the burn-rate
# recording rules cover 5m/30m/1h/6h windows only; true 28d accounting
# requires ad-hoc PromQL or an external SLO platform like Google Cloud
# Monitoring / Datadog SLO tracking).
promtool query instant ... 'sli:chat_reply:error_ratio_6h'
```

Or query the Prometheus UI at the VPS: `sli:*` series are recorded every
evaluation interval (1m scrape, 1m rule interval).
