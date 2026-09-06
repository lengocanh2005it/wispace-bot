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

<span id="botdown"></span><span id="botrestartloop"></span><span id="prometheusjobmissing"></span><span id="webhookinboundbackloggrowing"></span><span id="dataqualitycheckfailed"></span><span id="redisconsistencydrift"></span><span id="llmadmissionsaturated"></span><span id="internalauthrejectedspike"></span><span id="dbcircuitbreakeropen"></span><span id="studyreminderfailureshigh"></span><span id="platformlinkstatusunknown"></span><span id="tokenrefreshfailure"></span><span id="llmprovidercircuitopen"></span><span id="llmprovidersexhausted"></span><span id="llmdegradedmodehigh"></span><span id="llmusagetelemetryloss"></span><span id="llmunpricedtokens"></span><span id="llmmissingtokens"></span><span id="llminjectionblockedrise"></span><span id="chatidentitystaledetected"></span><span id="chatflushrecovery"></span><span id="studyreminderlockskipped"></span><span id="cronexecutionstale"></span><span id="chatavailabilitylow"></span><span id="llmlatencyhigh"></span><span id="llmerrorratehigh"></span><span id="eventlooplagp99high"></span><span id="wispacelatencyhigh"></span>

| Alert                        | Severity | First response                                                                                                                            |
| ---------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| BotDown                      | critical | Check `/health/ready`, container logs, and the last deploy; roll back only after preserving the failing image digest.                     |
| BotRestartLoop               | warning  | Inspect container exit reason, memory/CPU pressure, and startup configuration.                                                            |
| PrometheusJobMissing         | warning  | Check Prometheus target discovery, the stable `*-bot-metrics` aliases, and `/metrics` authorization.                                      |
| WebhookInboundBacklogGrowing | warning  | Inspect retry/abandon logs and the durable inbox; verify upstream webhook delivery and DB health.                                         |
| DataQualityCheckFailed       | warning  | Run `npm run ops:data-quality` under the ops lock and inspect the named check samples.                                                    |
| RedisConsistencyDrift        | warning  | Check Redis reachability and reconciliation outcomes; keep the Postgres source of truth intact.                                           |
| LlmAdmissionSaturated        | warning  | Inspect admission queue depth/rejections, provider latency, and `LLM_MAX_CONCURRENT` before changing limits.                              |
| InternalAuthRejectedSpike    | warning  | Review source IPs and rotate `INTERNAL_API_KEY` if the requests are not an operator action.                                               |
| DbCircuitBreakerOpen         | critical | Verify the database writer, TLS/CA settings, and pool saturation before restarting a bot.                                                 |
| StudyReminderFailuresHigh    | warning  | Inspect reminder delivery outcome and the platform sender; replay only after confirming idempotency state.                                |
| PlatformLinkStatusUnknown    | warning  | Check the WISPACE link-status endpoint and preserve mappings while the status check is unavailable.                                       |
| TokenRefreshFailure          | critical | Check the platform OAuth/OA credential and expiry; bootstrap/re-authorize before the cached token expires. The `reason` label is bounded. |
| LlmProviderCircuitOpen       | warning  | Check the named provider's error/quota telemetry and confirm another provider can serve traffic.                                          |
| LlmProvidersExhausted        | critical | Treat as a user-visible outage: inspect all provider keys, circuit state, and upstream status.                                            |
| LlmDegradedModeHigh          | warning  | Compare degraded actions with provider/admission failures; restore redundancy before raising limits.                                      |
| LlmUsageTelemetryLoss        | warning  | Check the usage-event database writer and retry/permission errors; billing evidence may be incomplete.                                    |
| LlmUnpricedTokens            | warning  | Add pricing for the bounded `model` label before using cost reports or quota forecasts.                                                   |
| LlmMissingTokens             | warning  | Inspect provider response usage fields and adapter versions; do not infer cost from raw text.                                             |
| LlmInjectionBlockedRise      | warning  | Review abuse telemetry and the source label; use sanitized excerpts/hashes only, never raw learner text.                                  |
| ChatIdentityStaleDetected    | warning  | Inspect link-state freshness and queue revalidation failures before replaying messages.                                                   |
| ChatFlushRecovery            | warning  | Investigate Redis/DB leases for `abandoned` or `fenced_stale` outcomes; verify no duplicate outbound send.                                |
| StudyReminderLockSkipped     | warning  | Confirm per-platform advisory lock ids and rolling-deploy overlap; a skip must not become the normal schedule.                            |
| CronExecutionStale           | warning  | Check the cron name, last-success/expected gauges, scheduler logs, and the advisory lock holder.                                          |
| ChatAvailabilityLow          | warning  | Compare chat step errors with upstream latency and provider exhaustion; inspect the affected bot job.                                     |
| LlmLatencyHigh               | warning  | Check provider latency, admission wait, and event-loop p99 before changing timeouts.                                                      |
| LlmErrorRateHigh             | warning  | Correlate failed rounds with provider/circuit and tool-policy telemetry.                                                                  |
| EventLoopLagP99High          | warning  | Inspect synchronous CPU work, event-loop lag p99, GC, and queue depth.                                                                    |
| WispaceLatencyHigh           | warning  | Check WISPACE p95 by service/operation, retry volume, and upstream availability.                                                          |

Every rule carries a `runbook_url` back to this document. Severity labels are
deliberately `warning` or `critical` so the Alertmanager routing work can map
them to independent channels without changing the recording rules.

## Metric classification

All custom families emitted by `BotMetricsService` are classified below. The
`<platform>_` notation means one family per bot registry.

### Alerted families

| Metric family                         | Rule                         |
| ------------------------------------- | ---------------------------- |
| `chat_step_duration_seconds`          | ChatAvailabilityLow          |
| `llm_call_duration_seconds`           | LlmLatencyHigh               |
| `llm_round_outcome_total`             | LlmErrorRateHigh             |
| `llm_provider_circuit_events_total`   | LlmProviderCircuitOpen       |
| `llm_providers_exhausted_total`       | LlmProvidersExhausted        |
| `llm_degraded_mode_total`             | LlmDegradedModeHigh          |
| `llm_usage_insert_failures_total`     | LlmUsageTelemetryLoss        |
| `llm_unpriced_model_tokens_total`     | LlmUnpricedTokens            |
| `llm_missing_tokens_total`            | LlmMissingTokens             |
| `llm_injection_blocked_total`         | LlmInjectionBlockedRise      |
| `wispace_call_duration_seconds`       | WispaceLatencyHigh           |
| `chat_identity_stale_detected_total`  | ChatIdentityStaleDetected    |
| `chat_flush_recovery_total`           | ChatFlushRecovery            |
| `token_refresh_failures_total`        | TokenRefreshFailure          |
| `study_reminder_lock_skips_total`     | StudyReminderLockSkipped     |
| `cron_registered_timestamp_seconds`   | CronExecutionStale           |
| `cron_expected_interval_seconds`      | CronExecutionStale           |
| `cron_last_success_timestamp_seconds` | CronExecutionStale           |
| `webhook_inbound_backlog`             | WebhookInboundBacklogGrowing |
| `data_quality_check_status`           | DataQualityCheckFailed       |
| `redis_consistency_drift`             | RedisConsistencyDrift        |
| `redis_consistency_events_total`      | RedisConsistencyDrift        |
| `llm_admission_rejected_total`        | LlmAdmissionSaturated        |
| `llm_admission_queue_depth`           | LlmAdmissionSaturated        |
| `internal_auth_rejected_total`        | InternalAuthRejectedSpike    |
| `db_circuit_breaker_state`            | DbCircuitBreakerOpen         |
| `reminder_dispatch_total`             | StudyReminderFailuresHigh    |
| `platform_link_transition_total`      | PlatformLinkStatusUnknown    |

### Deliberate no-alert families

These remain available for dashboards and incident correlation. They have no
stable page threshold, are expected product/policy outcomes, or are covered by
an actionable parent signal above.

| Metric families                                                                                                                                                                                                     | Reason                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat_revalidation_skip_total`          | Infrastructure-only revalidation misses are diagnosed with stale-identity and flush-recovery signals. |
| `webhook_inbound_inline_attempts_total`, `webhook_inbound_dispatch_lag_seconds`, `webhook_inbound_retention_deleted_total` | Transport, latency, and retention diagnostics; the backlog and bot availability rules are the actionable signals. |
| `retention_rows_deleted_total`, `retention_cleanup_errors_total`, `llm_usage_retention_deleted_total`, `chat_quota_retention_deleted_total` | Retention-only maintenance outcomes; investigate from cleanup logs unless retention becomes an explicit SLO. |
| `messenger_link_reconcile_records_total`, `discord_link_reconcile_records_total`, `zalo_link_reconcile_records_total` | Reconciliation volume/outcomes are diagnostic; link-status and bot availability alerts cover user impact. |
| Unprefixed compatibility `study_reminder_lock_skips_total` | Kept for existing in-process consumers; the prefixed registry family is the alert source. |
| `llm_execution_duration_seconds`, `llm_admission_wait_seconds`, `llm_admission_drain_lag_seconds`                                                                                                                   | Covered by provider/chat latency and queue depth; useful for diagnosis without a second page.                                                |
| `llm_provider_attempts_total`, `llm_tool_calls_total`, `llm_tool_duration_seconds`, `llm_observation_outcome_total`, `llm_tool_policy_denied_total`, `llm_classifier_verdict_total`, `clarification_outcomes_total` | Volume, policy, and model-loop diagnostics have no universal incident threshold.                                                             |
| `llm_concurrency_events_total`                                                                                                                                                                                      | Slot lifecycle is diagnosed through admission rejection/queue depth.                                                                         |
| `chat_quota_denied_total`, `write_tool_budget_denied_total`, `outbound_rate_limit_decisions_total`                                                                                                                  | Expected user/policy decisions; alerting would page on demand rather than failure.                                                           |
| `web_activity_webhook_received_total`, `scheduled_send_suppressed_total`                                                                                                                                            | Expected traffic/suppression signals, not failures.                                                                                          |
| `dm_delivery_failures_total`, `welcome_attempts_total`, `outbound_action_neutralized_total`                                                                                                                         | Low-volume per-platform/user outcomes; correlate with broader availability before paging.                                                    |
| `data_quality_runs_total`, `data_quality_check_failures_total`                                                                                                                                                      | The current `data_quality_check_status` gauge is the actionable latest state.                                                                |
| `db_circuit_breaker_failures_total`                                                                                                                                                                                 | Transient failures are noisy; the open-state gauge is actionable.                                                                            |
| `redis_consistency_events_total`                                                                                                                                                                                    | Resolved/detected/locked outcomes remain dashboard-only; unresolved/quarantined/unavailable increases are selected by RedisConsistencyDrift. |
| `platform_connectivity_ready`, `platform_connectivity_state`, `platform_connectivity_transitions_total`                                                                                                             | Readiness and `BotDown`/platform-specific health checks already cover availability.                                                          |

Prometheus `collectDefaultMetrics` also emits process/Node runtime families.
Only `nodejs_eventloop_lag_p99_seconds` is alertable here (`EventLoopLagP99High`);
the remaining default process, GC, memory, and event-loop quantiles are
dashboard-only until a service-specific baseline exists.

## Credential template check

`prometheus.tmpl` and `alertmanager.tmpl` use `${VAR}` placeholders, matching
the allow-listed `envsubst` calls in their entrypoints. Both entrypoints fail
closed if a credential placeholder survives rendering. Do not put secrets in
the committed templates. `TELEGRAM_CHAT_ID` has no sentinel default — an
unset value renders empty and trips the fail-closed check (#373).
`SRC`/`DST`/`DRY_RUN=1` override the template/output paths and skip the final
`exec`, so tests render with the real entrypoints without starting daemons.

## Staging verification

Before closing render-related changes, verify against staging and record the
results in the issue:

1. `curl` each bot's `/metrics` with no credentials → expect `401`.
2. `curl` with each `Authorization: Bearer <INTERNAL_API_KEY_*>` → expect
   `200` and a non-empty body.
3. Prometheus Targets page (or `/api/v1/targets`): `messenger_bot`,
   `discord_bot`, `zalo_bot` are all UP.
4. Send a test alert (Alertmanager `/api/v2/alerts`) → expect the Telegram
   message to arrive; then resolve it → expect the resolved notification.
5. Record pass/fail per step in the issue before closing it (paste redacted
   excerpts only — never keys, tokens, or full `/metrics` bodies).
