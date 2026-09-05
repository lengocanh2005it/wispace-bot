# Zalo Outbound Delivery Runbook (#244)

## Send API and idempotency

The Zalo OA send endpoint used by the bot is `POST /v3.0/oa/message/cs`
(`apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-outbound.service.ts`).

The documented payload contains the access token, recipient (`user_id`), and
message payload — **no client-supplied idempotency key or deduplication
contract**. Unlike Discord (which sends a stable `nonce` + `enforceNonce: true`
to dedupe retries), Zalo has no equivalent field. A retried request is a fresh
HTTP call that Zalo cannot correlate with an earlier attempt.

## Ambiguous delivery

A send is **ambiguous** when the request times out or fails at the network
level with **no HTTP status received** (`httpStatus === 0`). The bot cannot
know whether Zalo accepted the message:

For study reminders, `@wispace/study-reminder-shared` calls this sender with
`retryOn: 'none'` and `skipDeadLetter: true`. The shared reminder job is the
sole retry/recovery owner: an ambiguous result is persisted as terminal and
is surfaced for operator review. The general chat/report policy below remains
unchanged.

- The current policy retries an ambiguous outcome **once** (`maxRetries: 1`),
  then marks the delivery as `FAILED` and persists an outbound dead-letter.
- The `dm_send_ambiguous` metric (`${prefix}_dm_delivery_failures_total{reason="dm_send_ambiguous"}`)
  is incremented **at most once per send** (a flag dedupes multiple retry
  callbacks). See `zalo-outbound.service.ts:19,105-113,124-129`.
- Timeouts/aborts (`AbortError`) are **not** retried and are **not** counted as
  ambiguous — the verdict for those is treated as client-side only.

## Product tradeoff: duplicate vs lost message

Because Zalo cannot dedupe, a retried ambiguous send can deliver the same
message twice. The current policy accepts this tradeoff:

- **Duplicate risk**: retrying the ambiguous outcome once doubles the chance
  the user sees the message twice — but also covers the case where the first
  attempt genuinely failed before reaching Zalo.
- **Lost-message risk**: a no-retry policy would leave the message undelivered
  when the first attempt actually failed network-side.

The `dm_send_ambiguous` metric exists precisely because the verdict is
unknowable — it signals "reconcile manually if this spikes".

## Metrics guidance

| Metric                                                   | Meaning                                              | When to act                                                                    |
| -------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| `dm_delivery_failures_total{reason="dm_send_ambiguous"}` | Send outcome unknown (network-level, no HTTP status) | Investigate if sustained — may indicate Zalo API outage or network path issues |
| `dm_delivery_failures_total{reason="dm_send"}`           | Send failed after retries with a known status        | Fix the error (4xx config/recipient issues, 5xx provider issues)               |
| Outbound dead-letter rows (`webhook_dead_letters`)       | Persisted failed sends awaiting replay               | Review/cron-replay after the underlying issue is fixed                         |

## Future work

- Confirm with Zalo OA documentation/support whether the send API supports a
  client-supplied idempotency or deduplication key. If a field exists, use it
  for safe retries.
- If unsupported, an application-side reconciliation strategy (delivery
  records keyed by a client message ID, re-checked before replay) is the
  alternative — same pattern as the scheduled-send `delivery_record` (#181).
- Wire `userIdMappingLookup` for the study-reminder by-userId sync paths
  (see #191 follow-up).
