# Monitoring alerts and response guide

This is the source of truth for the Prometheus rules in
[`deploy/monitoring/alert.rules.yml`](../deploy/monitoring/alert.rules.yml).
Each bot exposes its custom metric families from a private registry with a
`messenger_`, `discord_`, or `zalo_` prefix. The alert rules select those
prefixes explicitly; the old unprefixed SLO selectors were inert and are now
gone.

## Alert contract

The heartbeat gauges are registered when a business-critical cron is wired:

- `<platform>_cron_registered_timestamp_seconds` — process registration time;
- `<platform>_cron_expected_interval_seconds` — configured expected interval;
- `<platform>_cron_last_success_timestamp_seconds` — last completed run.

`CronExecutionStale` fires when a registered cron has not completed for 2.5
expected intervals. A zero last-success value is handled separately so a
never-run job is not silently treated as healthy. The study-reminder
cleanup/rollover, dead-letter retry, reschedule recovery, report-claim
recovery, report-leader heartbeat, and Messenger quota recovery/consistency
jobs are included because they protect user-visible delivery or quota state;
unrelated retention-only jobs remain dashboard/log signals.

The initial event-loop ceiling is 500 ms p99. Re-baseline it against the
first seven days of healthy production data before changing the threshold.
WISPACE latency uses p95 >10 s for 10 minutes, while LLM latency keeps the
existing p95 >30 s rule, making the two upstream budgets comparable.

## Alert response

<span id="llmproviderneversucceeded"></span>
<span id="llmpromptcanarydetected"></span>

<span id="botdown"></span><span id="alertdeliveryfailed"></span><span id="botrestartloop"></span><span id="prometheusjobmissing"></span><span id="webhookinboundbackloggrowing"></span><span id="dataqualitycheckfailed"></span><span id="redisconsistencydrift"></span><span id="llmadmissionsaturated"></span><span id="internalauthrejectedspike"></span><span id="dbcircuitbreakeropen"></span><span id="studyreminderfailureshigh"></span><span id="privacycleanupincomplete"></span><span id="privacycleanuprecoverystuck"></span><span id="platformlinkstatusunknown"></span><span id="messengerlinkhandofffailure"></span><span id="tokenrefreshfailure"></span><span id="llmprovidercircuitopen"></span><span id="llmprovidersexhausted"></span><span id="llmdegradedmodehigh"></span><span id="llmusagetelemetryloss"></span><span id="llmunpricedtokens"></span><span id="llmmissingtokens"></span><span id="llminjectionblockedrise"></span><span id="chatidentitystaledetected"></span><span id="chatflushrecovery"></span><span id="studyreminderlockskipped"></span><span id="cronexecutionstale"></span><span id="chatavailabilitylow"></span><span id="llmlatencyhigh"></span><span id="llmerrorratehigh"></span><span id="eventlooplagp99high"></span><span id="wispacelatencyhigh"></span>

| Alert                        | Severity | First response                                                                                                                                                                                                                                                                                        |
| ---------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AlertDeliveryFailed          | critical | A receiver integration is failing (check `integration`/`reason` labels): verify the webhook URL, Pushover credential, or Telegram token; routing silence may otherwise go unnoticed (#683). Note: a failing warning-channel delivery still pages critical by design — the routing must be observable. |
| BotDown                      | critical | Check `/health/ready`, container logs, and the last deploy; roll back only after preserving the failing image digest.                                                                                                                                                                                 |
| BotRestartLoop               | warning  | Inspect container exit reason, memory/CPU pressure, and startup configuration.                                                                                                                                                                                                                        |
| PrometheusJobMissing         | warning  | Check Prometheus target discovery, the stable `*-bot-metrics` aliases, and `/metrics` authorization.                                                                                                                                                                                                  |
| WebhookInboundBacklogGrowing | warning  | Inspect retry/abandon logs and the durable inbox; verify upstream webhook delivery and DB health.                                                                                                                                                                                                     |
| DataQualityCheckFailed       | warning  | Run `npm run ops:data-quality` under the ops lock and inspect the named check samples.                                                                                                                                                                                                                |
| RedisConsistencyDrift        | warning  | Check Redis reachability and reconciliation outcomes; keep the Postgres source of truth intact.                                                                                                                                                                                                       |
| LlmAdmissionSaturated        | warning  | Inspect admission queue depth/rejections, provider latency, and `LLM_MAX_CONCURRENT` before changing limits.                                                                                                                                                                                          |
| InternalAuthRejectedSpike    | warning  | Review source IPs and rotate `INTERNAL_API_KEY` if the requests are not an operator action.                                                                                                                                                                                                           |
| DbCircuitBreakerOpen         | critical | Verify the database writer, TLS/CA settings, and pool saturation before restarting a bot.                                                                                                                                                                                                             |
| StudyReminderFailuresHigh    | warning  | Inspect reminder delivery outcome and the platform sender; replay only after confirming idempotency state.                                                                                                                                                                                            |
| PrivacyCleanupIncomplete     | warning  | Inspect the own-platform cleanup queue and Redis availability; use the opaque `cleanupId`/store list and do not search by raw external identity.                                                                                                                                                      |
| PrivacyCleanupRecoveryStuck  | critical | Verify Redis, the database writer, and the five-minute worker lease; relink fencing must retire stale jobs rather than clearing newer state.                                                                                                                                                          |
| PlatformLinkStatusUnknown    | warning  | Check the WISPACE link-status endpoint and preserve mappings while the status check is unavailable.                                                                                                                                                                                                   |
| MessengerLinkHandoffFailure  | warning  | Check Messenger intent lookup/persistence and ask the learner to retry only after the database path is healthy.                                                                                                                                                                                       |
| TokenRefreshFailure          | critical | Check the platform OAuth/OA credential and expiry; bootstrap/re-authorize before the cached token expires. The `reason` label is bounded.                                                                                                                                                             |
| LlmProviderCircuitOpen       | warning  | Check the named provider's error/quota telemetry and confirm another provider can serve traffic.                                                                                                                                                                                                      |
| LlmProviderNeverSucceeded    | warning  | Verify the named provider's credential and model configuration; a fallback may still be serving traffic, so restore redundancy before it becomes a full outage.                                                                                                                                       |
| LlmProvidersExhausted        | critical | Treat as a user-visible outage: inspect all provider keys, circuit state, and upstream status.                                                                                                                                                                                                        |
| LlmDegradedModeHigh          | warning  | Compare degraded actions with provider/admission failures; restore redundancy before raising limits.                                                                                                                                                                                                  |
| LlmUsageTelemetryLoss        | warning  | Check the usage-event database writer and retry/permission errors; billing evidence may be incomplete.                                                                                                                                                                                                |
| LlmUnpricedTokens            | warning  | Add pricing for the bounded `model` label before using cost reports or quota forecasts.                                                                                                                                                                                                               |
| LlmMissingTokens             | warning  | Inspect provider response usage fields and adapter versions; do not infer cost from raw text.                                                                                                                                                                                                         |
| LlmInjectionBlockedRise      | warning  | Review abuse telemetry and the source label; use sanitized excerpts/hashes only, never raw learner text.                                                                                                                                                                                              |
| LlmPromptCanaryDetected      | critical | Page through existing critical routing. Treat the hit as a possible provider, prompt, or model integrity failure; inspect only bounded operational signals and redacted logs. Never expose canary text, raw replies, or learner identities.                                                                                     |
| ChatIdentityStaleDetected    | warning  | Inspect link-state freshness and queue revalidation failures before replaying messages.                                                                                                                                                                                                               |
| ChatFlushRecovery            | warning  | Investigate Redis/DB leases for `abandoned` or `fenced_stale` outcomes; verify no duplicate outbound send.                                                                                                                                                                                            |
| StudyReminderLockSkipped     | warning  | Confirm per-platform advisory lock ids and rolling-deploy overlap; a skip must not become the normal schedule.                                                                                                                                                                                        |
| CronExecutionStale           | warning  | Check the cron name, last-success/expected gauges, scheduler logs, and the advisory lock holder.                                                                                                                                                                                                      |
| ChatAvailabilityLow          | warning  | Compare chat step errors with upstream latency and provider exhaustion; inspect the affected bot job.                                                                                                                                                                                                 |
| LlmLatencyHigh               | warning  | Check provider latency, admission wait, and event-loop p99 before changing timeouts.                                                                                                                                                                                                                  |
| LlmErrorRateHigh             | warning  | Correlate failed rounds with provider/circuit and tool-policy telemetry.                                                                                                                                                                                                                              |
| EventLoopLagP99High          | warning  | Inspect synchronous CPU work, event-loop lag p99, GC, and queue depth.                                                                                                                                                                                                                                |
| WispaceLatencyHigh           | warning  | Check WISPACE p95 by service/operation, retry volume, and upstream availability.                                                                                                                                                                                                                      |

### LlmPromptCanaryDetected response

`LlmPromptCanaryDetected` fires immediately when the five-minute window contains a positive canary-hit counter. `increase` detects later hits; `max_over_time` covers a first observed hit before two counter samples exist. The rule has no `for` delay. Existing `severity: critical` routing sends it to Discord critical, Pushover emergency, and Telegram.

1. Identify `job` and `platform`; compare recent deploy, prompt, provider, and model configuration changes.
2. Review bounded telemetry and sanitized operational logs.
3. Roll back or disable suspect configuration only after preserving redacted evidence.
4. Confirm the counter stops increasing after mitigation.

Privacy boundary: the metric carries only `job` and `platform`. Canary text, raw model replies, and learner identities must not enter labels, annotations, logs, tickets, or ad hoc queries. Use approved redacted evidence only.

### Scheduled report-wave capacity (#1363)

This is an operational diagnostic, not a new page. The background producer
must not exceed the local capacity contract:

```text
min(slots + maxQueueDepth,
    slots + floor(backgroundWaitMs * slots / requestTimeoutMs))
```

With the documented defaults (`3` slots, `50` queue entries, `1500ms`
background wait, `30000ms` request deadline), the safe producer concurrency is
`3`. An explicit producer value above that capacity is a startup failure, not a
silent clamp. `global_saturated` is a fleet-capacity signal only when Redis
global concurrency is enabled; local validation must not claim cross-pod
fairness.

When the #1363 instrumentation is deployed, investigate these bounded series:

- `<prefix>_llm_background_admission_total{platform,feature,attempt,outcome}`
- `<prefix>_llm_overload_regenerations_total{platform,feature}`
- `<prefix>_report_wave_completion_lag_seconds{platform}`

Use `increase(...[1d])` for daily views rather than adding a `day` label. A
`capacity_overload` occurs before the provider call and does not itself consume
LLM tokens; the durable report retry's typed `retry_cause` identifies the later
generation. The 08:00 wave's operational completion target is 09:00 ICT,
separate from the rolling 99% report-delivery SLO. Mixed interactive/background
fairness remains #580; do not raise the global limit as a first response.

Every rule carries a `runbook_url` back to this document. Severity labels are
deliberately `warning` or `critical` so the Alertmanager routing work can map
them to independent channels without changing the recording rules.

## Alert routing (#683)

Alertmanager routes on the `severity` label to channels of matching urgency —
see [`deploy/monitoring/alertmanager.tmpl`](../deploy/monitoring/alertmanager.tmpl):

| Severity | Receivers (fan-out)                                         | Urgency semantics                                                        |
| -------- | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| critical | `discord-critical` (@here marker) + `pushover` + `telegram` | Interrupt-grade via Pushover emergency; repeat 30m at Alertmanager level |
| warning  | `discord-warning` (no ping)                                 | Read during working hours; repeat 4h                                     |

Design decisions:

- **Three independent-by-platform legs for critical.** Pushover emergency
  priority is the true interrupt — it hard-pushes the phone, repeats every 5
  minutes until acknowledged, and gives up after 1 hour (the escalation
  window). Discord critical is the visual/high-context leg: the AM 0.27
  Discord receiver posts embeds only (no `content` field), so its `@here`
  marker renders in the message body but does not hard-ping. Telegram is kept
  as a third leg. No single platform outage silences critical paging. Discord
  is a _correlated_ failure mode for the Discord bot itself — that is why it
  must never be the only critical path.
- **Warnings never wake anyone.** They go to a no-ping Discord channel only.
- **Independence is per-platform, not per-host.** All in-band channels run on
  the VPS, so total host death is the scope of #515 (external deadman), not
  this routing.
- All receiver credentials are fail-closed (#536 renderer): missing/invalid
  `DISCORD_ALERT_WEBHOOK_CRITICAL_URL`, `DISCORD_ALERT_WEBHOOK_WARNING_URL`,
  `PUSHOVER_USER_KEY`, or `PUSHOVER_API_TOKEN` aborts the Alertmanager
  container. Discord URLs must be HTTPS on `discord.com`/`discordapp.com`;
  Pushover keys must be alphanumeric.
- The root route defaults to `discord-warning`, so an alert with a missing
  severity label degrades to low urgency instead of vanishing.

### Channel setup (one-time)

1. Discord server: create `#alerts-critical` and `#alerts-warnings`; create
   one webhook per channel (`Channel settings → Integrations → Webhooks`) and
   copy the URLs into `DISCORD_ALERT_WEBHOOK_*_URL`.
2. Pushover: create a user account, purchase the (one-off) license, create an
   application, and copy `User Key`/`API Token` into `PUSHOVER_USER_KEY` /
   `PUSHOVER_API_TOKEN`. Install the phone app and allow emergency-priority
   notifications.
3. Secrets reach the VPS through the Vault workflow (see
   `docs/vault-secrets.md`), never committed.

### Synthetic path probe

`deploy/monitoring/synthetic-alert.sh` exercises the full path in-band:

- **Daily 09:07 ICT** (02:07 UTC cron): `severity=warning` → exercises the
  `#alerts-warnings` leg only, no human interrupt.
- **Monday 09:02 ICT** (02:02 UTC cron): `severity=critical` → exercises all
  three critical legs including a Pushover hard ping. Weekly, not daily, so
  the probe does not erode the interrupt value of the channels.

The script posts `SyntheticRoutingCheck` to the Alertmanager API, waits for
evaluation + fan-out, verifies the alert is pending, posts the resolve, and
verifies it clears — exit 0/1, logged as evidence. The alert carries a 5-minute
`endsAt`, so a crashed probe auto-expires instead of leaving a firing alert.
Delivery _failures_ are detected continuously by the `AlertDeliveryFailed`
rule on `alertmanager_notifications_failed_total` (Prometheus now scrapes the
Alertmanager job itself). Out-of-band host-death detection remains #515.

## Blackout watchdog (#515)

Everything above runs on the production VPS. If the host itself dies, every
in-band channel goes silent together — the external watchdog is the only
signal that survives:

1. **Always-firing `Watchdog` alert** (`alert.rules.yml`, `severity: none`).
   Alertmanager intercepts it (`alertname="Watchdog"` route, first in the
   tree, no fan-out into the critical channels) and pings the healthchecks.io
   check every 2 minutes via a webhook receiver. `send_resolved: false` — a
   resolved notification when Prometheus dies must not fake-alive the
   heartbeat.
2. **healthchecks.io** (external, free tier) hosts two checks:
   - `alertmanager-watchdog`: period 10m, grace 5m — the heartbeat stops when
     Prometheus, the rules, Alertmanager, nginx, or the host itself dies;
     the missing ping pages within ~15 minutes.
   - `public-health-probe`: period 30m, grace 15m — fed by cron-job.org
     (every 5 minutes, GET `https://aiassist.aihubproduction.com/health/ready`;
     success → ping, failure → `/fail` ping) so a broken public route is also
     seen from outside the VPS.
3. Both checks notify through healthchecks.io's own integrations — **Pushover
   (emergency priority) + email** — independent of the dead VPS.

`HEALTHCHECKS_PING_URL` is a fail-closed credential like the rest: the
Alertmanager entrypoint refuses to start without a valid
`https://hc-ping.com/<uuid>` URL. The probe check's ping URL lives only in
the cron-job.org dashboard, never in the repo.

### Blackout scenario (runbook)

Symptom: **Pushover push "alertmanager-watchdog is DOWN" (or
"public-health-probe") + email** from healthchecks.io, while Discord/Telegram
are silent (nothing on the VPS is alive to send them).

Recovery order:

1. **Confirm the host** — VPS provider console / ping; OOM, kernel panic, or
   provider outage are the usual causes.
2. **Boot the host**; docker restarts via `restart: unless-stopped`.
3. **Verify the pipeline refilled**: healthchecks.io check flips back to
   "up" within ~2 minutes (Watchdog pings resume), Prometheus targets
   (`/api/v1/targets`) all `up`, `docker ps` shows the three bots healthy.
4. **Post-mortem**: check `~/infra/monitoring` config survived (backup:
   `~/infra/monitoring.bak-683`), review `/var/log/syslog`/dmesg for the
   crash cause, and record the downtime against the error budget.

The webhook route and the `Watchdog` rule are deliberately the first entries
in their respective files — removing or reordering them silently disables the
external deadman; the routing tests fail on removal and assert the intercept
sits before the severity routes (`test-rendered-config-validation.sh`,
`test-alertmanager-entrypoint.sh`).

## Metric classification

All custom families emitted by `BotMetricsService` are classified below. The
`<platform>_` notation means one family per bot registry.

### Alerted families

| Metric family                                                                                  | Rule                         |
| ---------------------------------------------------------------------------------------------- | ---------------------------- |
| `chat_step_duration_seconds`                                                                   | ChatAvailabilityLow          |
| `llm_call_duration_seconds`                                                                    | LlmLatencyHigh               |
| `llm_round_outcome_total`                                                                      | LlmErrorRateHigh             |
| `llm_provider_circuit_events_total`                                                            | LlmProviderCircuitOpen       |
| `llm_provider_never_succeeded_total`                                                           | LlmProviderNeverSucceeded    |
| `llm_providers_exhausted_total`                                                                | LlmProvidersExhausted        |
| `llm_degraded_mode_total`                                                                      | LlmDegradedModeHigh          |
| `llm_usage_insert_failures_total`                                                              | LlmUsageTelemetryLoss        |
| `llm_unpriced_model_tokens_total`                                                              | LlmUnpricedTokens            |
| `llm_missing_tokens_total`                                                                     | LlmMissingTokens             |
| `llm_injection_blocked_total`                                                                  | LlmInjectionBlockedRise      |
| `llm_prompt_canary_hit_total`                                                                  | LlmPromptCanaryDetected     |
| `wispace_call_duration_seconds`                                                                | WispaceLatencyHigh           |
| `chat_identity_stale_detected_total`                                                           | ChatIdentityStaleDetected    |
| `chat_flush_recovery_total`                                                                    | ChatFlushRecovery            |
| `token_refresh_failures_total`                                                                 | TokenRefreshFailure          |
| `study_reminder_lock_skips_total`                                                              | StudyReminderLockSkipped     |
| `cron_registered_timestamp_seconds`                                                            | CronExecutionStale           |
| `cron_expected_interval_seconds`                                                               | CronExecutionStale           |
| `cron_last_success_timestamp_seconds`                                                          | CronExecutionStale           |
| `webhook_inbound_backlog`                                                                      | WebhookInboundBacklogGrowing |
| `data_quality_check_status`                                                                    | DataQualityCheckFailed       |
| `redis_consistency_drift`                                                                      | RedisConsistencyDrift        |
| `redis_consistency_events_total`                                                               | RedisConsistencyDrift        |
| `llm_admission_rejected_total`                                                                 | LlmAdmissionSaturated        |
| `llm_admission_queue_depth`                                                                    | LlmAdmissionSaturated        |
| `internal_auth_rejected_total`                                                                 | InternalAuthRejectedSpike    |
| `db_circuit_breaker_state`                                                                     | DbCircuitBreakerOpen         |
| `reminder_dispatch_total`                                                                      | StudyReminderFailuresHigh    |
| `platform_link_transition_total`                                                               | PlatformLinkStatusUnknown    |
| `messenger_link_handoff_failures_total`                                                        | MessengerLinkHandoffFailure  |
| `privacy_cleanup_pending_jobs`                                                                 | PrivacyCleanupIncomplete     |
| `privacy_cleanup_pending_job_age_seconds`, `privacy_cleanup_attempts_total{outcome="failure"}` | PrivacyCleanupRecoveryStuck  |

### Deliberate no-alert families

These remain available for dashboards and incident correlation. They have no
stable page threshold, are expected product/policy outcomes, or are covered by
an actionable parent signal above.

| Metric families                                                                                                                                                                                                     | Reason                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat_revalidation_skip_total`                                                                                                                                                                                      | Infrastructure-only revalidation misses are diagnosed with stale-identity and flush-recovery signals.                                                                   |
| `webhook_inbound_inline_attempts_total`, `webhook_inbound_dispatch_lag_seconds`, `webhook_inbound_retention_deleted_total`                                                                                          | Transport, latency, and retention diagnostics; the backlog and bot availability rules are the actionable signals.                                                       |
| `retention_rows_deleted_total`, `retention_cleanup_errors_total`, `llm_usage_retention_deleted_total`, `chat_quota_retention_deleted_total`                                                                         | Retention-only maintenance outcomes; investigate from cleanup logs unless retention becomes an explicit SLO.                                                            |
| `messenger_link_reconcile_records_total`, `discord_link_reconcile_records_total`, `zalo_link_reconcile_records_total`                                                                                               | Reconciliation volume/outcomes are diagnostic; link-status and bot availability alerts cover user impact.                                                               |
| `messenger_link_completion_total`                                                                                                                                                                                   | Completion claim/lease outcomes are diagnostic; `MessengerLinkHandoffFailure` covers durable handoff failures.                                                          |
| Unprefixed compatibility `study_reminder_lock_skips_total`                                                                                                                                                          | Kept for existing in-process consumers; the prefixed registry family is the alert source.                                                                               |
| `llm_execution_duration_seconds`, `llm_admission_wait_seconds`, `llm_admission_drain_lag_seconds`                                                                                                                   | Covered by provider/chat latency and queue depth; useful for diagnosis without a second page.                                                                           |
| `llm_provider_attempts_total`, `llm_tool_calls_total`, `llm_tool_duration_seconds`, `llm_observation_outcome_total`, `llm_tool_policy_denied_total`, `llm_classifier_verdict_total`, `clarification_outcomes_total` | Volume, policy, and model-loop diagnostics have no universal incident threshold.                                                                                        |
| `llm_provider_outcomes_total`                                                                                                                                                                                       | Per-call provider success/failure diagnostics; never-served and exhaustion alerts are the actionable capacity signals.                                                  |
| `llm_concurrency_events_total`                                                                                                                                                                                      | Slot lifecycle is diagnosed through admission rejection/queue depth.                                                                                                    |
| `llm_background_admission_total`, `llm_overload_regenerations_total`, `report_wave_completion_lag_seconds`                                                                                                           | #1363 diagnostics; collect a baseline before creating a page threshold.                                                                                                |
| `chat_quota_denied_total`, `write_tool_budget_denied_total`, `outbound_rate_limit_decisions_total`                                                                                                                  | Expected user/policy decisions; alerting would page on demand rather than failure.                                                                                      |
| `web_activity_webhook_received_total`, `scheduled_send_suppressed_total`                                                                                                                                            | Expected traffic/suppression signals, not failures.                                                                                                                     |
| `dm_delivery_failures_total`, `welcome_attempts_total`, `outbound_action_neutralized_total`                                                                                                                         | Low-volume per-platform/user outcomes; correlate with broader availability before paging.                                                                               |
| `reengagement_send_total`, `reengagement_batch_duration_seconds`                                                                                                                                                    | Re-engagement outcomes are expected product results (incl. `mark_sent_error`, an at-least-once state); the daily batch cron is watched via `CronExecutionStale` (#855). |
| `data_quality_runs_total`, `data_quality_check_failures_total`                                                                                                                                                      | The current `data_quality_check_status` gauge is the actionable latest state.                                                                                           |
| `db_circuit_breaker_failures_total`                                                                                                                                                                                 | Transient failures are noisy; the open-state gauge is actionable.                                                                                                       |
| `redis_consistency_events_total`                                                                                                                                                                                    | Resolved/detected/locked outcomes remain dashboard-only; unresolved/quarantined/unavailable increases are selected by RedisConsistencyDrift.                            |
| `platform_connectivity_ready`, `platform_connectivity_state`, `platform_connectivity_transitions_total`                                                                                                             | Readiness and `BotDown`/platform-specific health checks already cover availability.                                                                                     |

Prometheus `collectDefaultMetrics` also emits process/Node runtime families.
Only `nodejs_eventloop_lag_p99_seconds` is alertable here (`EventLoopLagP99High`);
the remaining default process, GC, memory, and event-loop quantiles are
dashboard-only until a service-specific baseline exists.

## Credential template check

`prometheus.tmpl` and `alertmanager.tmpl` use only `${VAR}` placeholders,
matching the allow-listed substitutions in their entrypoints: a small awk
renderer replaces only the listed names and YAML-escapes quotes/backslashes in
secret values. Legacy `__VAR__`, `$VAR`, malformed, or unallow-listed markers
are rejected before startup, and a broad post-render guard fails closed if one
survives. Do not put secrets in the committed templates. `TELEGRAM_CHAT_ID`
has no sentinel default and must be a valid non-zero signed 64-bit integer — an
unset or invalid value fails closed (#373). The #683 receivers add four more
fail-closed credentials to the allow-list: both Discord webhook URLs must be
HTTPS on `discord.com`/`discordapp.com`, and both Pushover keys must be
alphanumeric.
`SRC`/`DST`/`DRY_RUN=1` override the template/output paths and skip the final
`exec`, so tests render with the real entrypoints without starting daemons.

## Post-deploy verification

There is no separate staging environment — verification happens in two layers:

### Local rehearsal (pre-merge, needs Docker)

1. Copy `deploy/monitoring/.env.example` to `.env` with dummy creds.
2. `docker compose -f deploy/monitoring/docker-compose.yml up -d` → both
   containers must stay up (not restart-looping — this exercises the real
   entrypoints end to end).
3. `curl localhost:9090/-/healthy` and `localhost:9093/-/healthy` → 200.
   (Scrape targets will be DOWN locally — the bots aren't there; UP is
   checked post-deploy.)
4. `docker compose down`.

### Post-deploy VPS checks (before closing the issue)

1. `curl` each bot's `/metrics` with no credentials → expect `401`.
2. `curl` with each `Authorization: Bearer <INTERNAL_API_KEY_*>` → expect
   `200` and a non-empty body.
3. Prometheus Targets page (or `/api/v1/targets`): `messenger_bot`,
   `discord_bot`, `zalo_bot`, and `alertmanager` are all UP.
4. Send a test alert (Alertmanager `/api/v2/alerts`):
   - `severity=warning` → expect a message in `#alerts-warnings` only.
   - `severity=critical` → expect messages in `#alerts-critical` (with
     @here), the Pushover app (emergency priority), and Telegram; resolve it
     → expect resolved notifications on all legs.
   - Or run `SYNTHETIC_SEVERITY=critical deploy/monitoring/synthetic-alert.sh`.
5. Record pass/fail per step in the issue before closing it (paste redacted
   excerpts only — never keys, tokens, or full `/metrics` bodies).
