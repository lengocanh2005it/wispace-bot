# LLM Fallback Policy (#422)

This is the operational contract for Messenger, Discord, and Zalo. Every
failure has one owner and one next action; callers must not add another retry
loop around that action.

## Fault Matrix

| Fault                                  | Chat                                                                                                                                                                                             | Report / reminder                                                                                                                                                                       | Owner and bound                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Request timeout or cancellation        | Abort the provider/tool call; send the fixed chat fallback. Do not append the failed assistant turn.                                                                                             | Abort the current generation; keep the job retryable in its outbox when delivery is still known not to have happened.                                                                   | One caller deadline; provider retry stops on abort.      |
| Rate limit                             | Bounded same-operation retry, then approved-provider failover; if all fail, fixed fallback.                                                                                                      | Bounded provider attempt/failover; generation or delivery is recorded for the durable job retry.                                                                                        | Execution port/provider adapter; no caller retry on top. |
| Auth or configuration error            | Fail closed; no retry or tool execution; fixed fallback at runtime.                                                                                                                              | Configuration fails startup; a runtime auth failure is terminal for the attempt and requires operator correction.                                                                       | Provider factory/circuit; no automatic replay.           |
| Provider exhaustion                    | Fixed Vietnamese service-unavailable response; no stale context, history append, or user-visible partial model content.                                                                          | Keep generation retryable in `report_send_jobs` / `study_reminder_jobs`; do not send an ungrounded report/reminder.                                                                     | Report/reminder outbox and bounded retry count.          |
| Malformed model output / invalid JSON  | Treat the round as failed; use the fixed error/fallback path.                                                                                                                                    | Use deterministic source-derived report/reminder content when facts exist; otherwise keep the job retryable.                                                                            | Shared parser and deterministic formatter.               |
| Unknown tool or invalid arguments      | Emit a failed, bounded tool observation; never call the executor or authorize a side effect.                                                                                                     | Not applicable to deterministic reminder delivery; report generation follows malformed-output handling.                                                                                 | Shared tool registry/validator.                          |
| Tool timeout or partial tool failure   | Abort the tool with its signal, return a failed observation, and let the agent stop or answer only from successful grounded tools.                                                               | A background job remains retryable only when its durable job policy allows it.                                                                                                          | Tool timeout budget and agent round cap.                 |
| WISPACE upstream failure               | Show an error observation; never invent scores, dates, sessions, or links.                                                                                                                       | `no-score` returns the deterministic guidance message; retryable 5xx/timeouts enter the durable outbox; non-retryable errors use the unavailable/terminal message.                      | WISPACE retry classifier and report/reminder job owner.  |
| History or clarification state failure | Configured Redis history/state fails closed at startup. A runtime blip uses the documented empty/conversational fallback and emits an error metric/log; it never claims coherent shared history. | Do not persist a misleading assistant turn or consume clarification state after a failed write.                                                                                         | Store resolver/state machine; startup health gate.       |
| Queue or quota failure                 | Bounded queue rejects or drops only according to the pending-message cap; send one drop notice per cycle. Quota is refunded when no reply was delivered.                                         | Background work sheds before chat; the durable job lease is released or retried.                                                                                                        | Queue/quota service and lease owner.                     |
| Outbound delivery failure              | Send the fixed fallback at most once per processing cycle. Ambiguous delivery is not blindly replayed.                                                                                           | Non-ambiguous retryable failure goes to the report/reminder outbox. Ambiguous delivery is terminally marked with a delivery key; replay requires an idempotency key or manual recovery. | Platform outbound adapter plus one durable retry owner.  |

## Budgets and ownership

- `LLM_MAX_CONCURRENT`, `LLM_MAX_QUEUE_DEPTH`, and the interactive/background
  admission wait budgets bound work before a provider call.
- One `AbortSignal` and one `LLM_REQUEST_TIMEOUT_MS` cover admission, the
  optional Redis-global slot, provider attempts, failover, and backoff. The
  shared execution circuit opens after repeated provider failures and resets
  after its cooldown.
- Provider retry and failover are bounded by `LLM_OPENAI_RETRY_MAX_ATTEMPTS`
  and the approved order in `LLM_PROVIDER_FAILOVER_ORDER`. A listed provider
  must be known and configured; unknown names and incomplete entries fail
  startup. A single configured provider emits a startup warning because no
  redundancy is available.
- Chat queue retry is for recovering the queued user turn only. It never
  re-enqueues a fixed fallback as a new turn. Report and reminder retry is
  owned by the durable outbox/lease, not by a second platform send loop.
- Discord reuses its stable nonce for an idempotent replay. Zalo has no
  idempotency field, so an ambiguous Zalo send is not automatically replayed.

## Telemetry and alerts

Use masked external IDs and the existing correlation id in logs. Do not put
user text, prompts, tool results, tokens, or raw provider bodies in metrics or
logs. The low-cardinality signals are:

- `<prefix>_llm_provider_attempts_total`,
  `<prefix>_llm_provider_circuit_events_total`, and
  `<prefix>_llm_providers_exhausted_total` for provider routing;
- `<prefix>_llm_admission_rejected_total`,
  `<prefix>_llm_admission_queue_depth`, and
  `<prefix>_llm_admission_drain_lag_seconds` for bounded load shedding;
- `<prefix>_llm_concurrency_events_total{outcome}` for Redis-global slot
  lifecycle outcomes (`acquired`, `rejected`, `stale_release`, `released`,
  and `release_error`);
- `<prefix>_llm_round_outcome_total`,
  `<prefix>_llm_observation_outcome_total`, and clarification outcomes for
  safe chat degradation;
- outbox backlog, terminal-failure, dead-letter, and `dm_send_ambiguous`
  metrics for recovery ownership.

Alert an operator when provider exhaustion or admission rejection persists for
5 minutes, when queue depth stays above 80% of its configured cap, or when an
ambiguous/dead-letter item remains pending for one dispatch interval. These
are starting thresholds; tune them from the production baseline rather than
raising retry counts first.

## Rollout and rollback

1. Deploy telemetry and contract tests first. Roll out Messenger, then
   Discord, then Zalo while watching provider exhaustion, admission, outbox,
   and ambiguous-delivery signals.
2. To shed LLM work immediately, set `LLM_EXECUTION_ENABLED=false` and keep
   deterministic report/reminder paths enabled. To remove one provider, edit
   the approved failover order and redeploy; do not leave an unknown or
   keyless entry in the order.
3. Roll back the application image if fallback rates, duplicate delivery, or
   lease backlog regress. Existing durable jobs remain the recovery source;
   do not manually resend an ambiguous Zalo item without confirming delivery
   first.

## Manual recovery

Manual action is required for malformed configuration, authentication failures,
terminal outbox exhaustion, and ambiguous sends without an idempotency key.
Confirm the provider status and the durable claim/job state, correct the
configuration or recipient mapping, then replay only a known `not_sent` item.
Never turn a `sent` or `ambiguous` claim back into an automatic resend.
