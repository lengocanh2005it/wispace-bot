# Threat model — WISPACE data access and scheduled outbound flows

Deliverable for #915. Read 2026-09-13.

Scope: what happens **after** a platform identity is verified — the WISPACE
learner read, the report and reminder paths that carry that data back out, the
cache between them, and the privileged operations that can trigger any of it.
The account-link protocol itself is #729's model and is treated here as a
precondition, not re-derived.

Field-level inventory of everything persisted along these flows lives in
[`data-catalog.md`](./data-catalog.md).

## Assets

| Asset | Where it lives |
| --- | --- |
| Learner study data (goals, target score, exam date, calendar, task scores) | WISPACE API; cached in `learner_profiles` and the Redis WISPACE cache |
| The learner's own message text | `webhook_inbound_events.raw_payload`, `webhook_dead_letters.raw_payload`, chat history in Redis, and the LLM provider's request body |
| Generated competency reports | Transient; delivered outbound, not stored as text |
| Platform ↔ WISPACE identity binding | `user_platform_mappings`, `discord_account_links`, `zalo_account_links` |
| `WISPACE_INTERNAL_KEY` | Bot process environment |
| `INTERNAL_API_KEY` | Bot process environment; held by every operator and automation that calls ops HTTP |

## Principals

- **Learner** — interacts through Messenger, Discord, or Zalo. Authenticated
  only as a platform user id.
- **Bot process** — holds `WISPACE_INTERNAL_KEY`; speaks to WISPACE on behalf
  of any learner it chooses to name.
- **WISPACE API** — owns the authorization decision for learner data.
- **Operator / automation** — holds `INTERNAL_API_KEY`; can trigger sends,
  read usage, and reach privacy endpoints.
- **LLM provider** — receives learner data as prompt content.
- **Platform (Meta / Discord / Zalo)** — delivers inbound events and accepts
  outbound messages; owns recipient addressing.

## Trust boundaries

```
B1  learner → platform → webhook/gateway      (untrusted input, signature-verified)
B2  bot → WISPACE API                          (shared internal key, no learner credential)
B3  bot → LLM provider                         (learner data leaves the system)
B4  bot → platform Send API                    (recipient addressing)
B5  operator → ops HTTP                        (one static key)
B6  bot → Redis / Postgres                     (shared across all three bots)
```

**The load-bearing property of B2:** the bot presents `x-psid` /
`x-discordid` / `x-zaloid` plus `X-Internal-Key`
(`packages/wispace-client/src/utils/wispace-headers.ts`). It never presents a
WISPACE user credential. WISPACE resolves the platform id to a learner and
decides what may be read. Two consequences follow, and most of this model is
downstream of them:

1. **The ACL is entirely upstream.** The bot cannot verify that the data it
   received belongs to the learner it meant to ask about. If it sends the
   wrong external id, it receives the wrong learner's data and nothing in this
   repository can detect it. Every authorization invariant on this side is
   therefore about *sending the right id*, never about *checking the answer*.
2. **`WISPACE_INTERNAL_KEY` is a learner-data master key.** It is one shared
   secret, identical across all three bots, with no per-learner scoping. Anyone
   holding it can read any learner's data by naming platform ids. This is the
   single highest-value secret in the system and it has no rotation path
   (#690) and no per-request scoping.

## Flow 1 — Learning-data ACL reads and writes

**Path:** chat tool call or scheduled job → capability port adapter → client
in `packages/wispace-client` → WISPACE.

**Identity key:** `externalUserId` + `platform`, baked into the id header at
each bot's adapter. WISPACE `userId` is *not* sent.

**Invariant:** the external id sent must be the one whose message or job is
being served, and it must still be bound to the learner the caller believes
it is.

| Abuse / failure case | Control | Evidence |
| --- | --- | --- |
| Learner A's tool call reads learner B's data | Id comes from the verified inbound event, never from model output | Adapters bake `idHeader` per bot; the agent core has no access to identity |
| Prompt injection makes the model name another learner | Tool arguments carry no identity field — identity is supplied by the adapter, not the model | `packages/chat-agent/src/agent/wispace-capability.ports.ts` |
| Malformed upstream response treated as valid | zod validation at every client, failing closed into the retry path | ADR 0010 |
| Stale binding: id still resolves upstream after unlink | **Not detectable here** — WISPACE owns it | residual R1 |
| `WISPACE_INTERNAL_KEY` compromise | none beyond secret hygiene | #690, residual R2 |

## Flow 2 — Student report to the LLM and provider boundary

**Path:** cron or retry → capacity fetch → `StudentReportCore` → LLM provider
→ formatted text → platform Send API.

**Assets crossing B3:** target score, exam date, per-skill task-score averages
— a learner's academic performance, sent to a third party.

| Abuse / failure case | Control | Evidence |
| --- | --- | --- |
| Report generated for the wrong learner | Capacity fetch uses the same external id as delivery | Flow 1's invariant |
| Report delivered to a recipient who is no longer that learner | **Gap on the retry path** — the claimed job's `userId` is not compared against the freshly resolved mapping | #1000 |
| Learner data retained by the provider | Contractual/config, not enforced in code | #620, residual R3 |
| More data sent than the report needs | No minimization boundary — tool results go out whole up to the character cap | #1077, #1100 |
| Provider failure leaks data through an error path | Errors are masked before logging | `packages/bot-common/src/masking` |

## Flow 3 — Study-reminder recipient authorization

This is the flow with the strongest control in the system, and it is worth
recording *why*, because the same shape is what Flow 2's retry path is
missing.

**Invariant:** a reminder queued for learner L at mapping generation G is
delivered only if the recipient's mapping still resolves to L at generation G.

**Control:** the dispatcher re-resolves the owner at claim time and cancels
the job when `owner.mappingGeneration !== claimedJob.mappingGeneration`, or
when either is missing — fail-closed, not fail-open
(`packages/study-reminder-shared/src/services/study-reminder-dispatch.service.ts:200-208`
and `:380-381`). Shipped by #999.

| Abuse / failure case | Control |
| --- | --- |
| Relink between queue and send | Generation fence cancels the job |
| Mapping generation absent on either side | Cancelled with `mapping_generation_missing` — absence is treated as failure |
| Duplicate delivery after a crash | Lease token + `delivery_key` / `delivery_status` on the job row |
| Platform user id reused by the platform for a new person | Covered only if the reuse produced a new mapping generation — otherwise **not covered**; residual R4 |

## Flow 4 — WISPACE cache identity and invalidation

**Path:** `WispaceDataCache` in front of every WISPACE read, optionally backed
by `RedisWispaceCacheStore`.

**Two findings, both verified by reading the key construction and the call
sites:**

1. **Cache keys carry no platform segment.** `buildKey` produces
   `<ns><externalUserId><sep><kind><sep><args>`
   (`packages/wispace-client/src/cache/wispace-data-cache.ts:333-343`), and
   `RedisWispaceCacheStore`'s constructor takes no key prefix
   (`redis-wispace-cache.store.ts:40-46`). All three bots construct it the same
   way against the same Redis instance. The port's own documentation says a
   shared store "may prefix it with a platform namespace" — *may*, and none
   does. Collision between a PSID, a Discord id, and a Zalo id is improbable
   because the id spaces differ in shape, but nothing structurally prevents
   it, and `invalidateUser`'s prefix delete spans the shared namespace.
2. **Nothing invalidates on relink or erasure.** The only `invalidateUser`
   callers are the bots' own goal/calendar mutation adapters
   (`apps/discord-bot/.../discord-wispace-capability.adapters.ts:96,100` and
   the Zalo equivalents). A relink or a deletion request leaves the previous
   learner's cached goals and calendar under a key that the new owner of that
   platform id will hit, until TTL expiry.

Owner: #877. This model's contribution is the evidence and the second finding
being distinct from the first.

## Flow 5 — Privileged operations touching learner data

**Surface** (all `@UseGuards(InternalApiKeyGuard, ThrottlerGuard)`):
`messenger/*` scheduler ops, `messenger/ops/llm-usage`,
`messenger/wispace/*` web activity, `discord/link-status`, and the ops routes
on `MessengerController`.

**Control:** one static `INTERNAL_API_KEY`, compared with `timingSafeEqual`,
failing closed when unset (`packages/bot-common/src/guard/internal-api-key.guard.ts`).

| Abuse / failure case | Control | Evidence |
| --- | --- | --- |
| Key compromise | none — one key authorizes every operation from a report send to a learner data export | #770 |
| No attribution of who acted | none — the guard authenticates the key, not a person | #641 |
| Invalid operator input reaching learner data | Per-route validation only | — |
| Throttling shared rather than per-caller | One global bucket, keyed to nginx's IP | #691 |

The gap here is not authentication, which is sound; it is that authorization
has one level and actions have no actor.

## Cross-cutting cases required by #915

| Case | Where it lands |
| --- | --- |
| **Relink** | Reminders fenced (#999). Report retry **not** fenced (#1000). Cache **not** invalidated (#877). Chat state (#857) |
| **Stale mapping** | Same three; the mapping tables carry `link_state`, `last_verified_at`, `mapping_generation` to make staleness expressible |
| **User-id reuse** | Only covered where reuse changes the mapping generation. Residual R4 |
| **Cache / history replay** | Cache: #877. Chat history isolation: #857 |
| **Concurrent unlink/delete** | #856; `PrivacyDataService.delete` runs in one transaction with a conflict check |
| **Provider failure** | Failover, circuit breaker, degraded reply; masked errors |
| **Duplicate delivery** | Lease tokens + `delivery_key`/`delivery_status` on every outbox row |
| **Invalid operator input** | Per-route validation; no schema gate across the ops surface |

## Residual risks

Each has an owner or an explicit decision, per #915's criteria.

| # | Risk | Disposition |
| --- | --- | --- |
| R1 | The bot cannot verify that returned data belongs to the learner it asked about; the ACL is upstream | **Accepted, upstream.** WISPACE owns it. Needs a maintainer to record the acceptance |
| R2 | `WISPACE_INTERNAL_KEY` is an unscoped, unrotatable master key for all learner data | #1123 (scope and blast radius); #690 covers rotation separately |
| R3 | Learner data sent to the LLM provider is governed by configuration and contract, not code | #620, #1077, #1100 |
| R4 | Platform user-id reuse that does not change the mapping generation defeats the reminder fence | #1124 |
| R5 | Report retry can deliver to a recipient who is no longer the queued learner | #1000 |
| R6 | Cache survives relink and erasure; keys carry no platform segment | #877 |
| R7 | One ops key, no actor attribution | #770, #641 |
| R8 | Erasure does not reach seven tables carrying learner identifiers, two holding raw message text | Owned in pieces: #908 (raw payloads), #540 (`reschedule_confirmations`), #556 (`llm_safety_events` and the unbounded per-user tables), #541 (`chat_quota_events`), #522, #448. #1125 closes the remainder — `message_logs` and `chat_tool_daily_usage` |

**Every residual now has an owner**, which is what #915's criteria require
before it closes. The three that had none when this model was first written
were filed as #1123 (is a per-learner or per-bot WISPACE credential possible
upstream, and what is the blast radius if not?), #1124 (is platform id reuse a
real case for Meta, Discord, and Zalo, and does each produce a new
generation?), and #1125 (the two tables the existing erasure issues do not
name).

Two of those three are questions whose answer may be "no change needed" —
#1123 depends on what WISPACE can issue, and #1124 on what the three platforms
actually do with identifiers. A documented "not reachable, here is the
citation" closes them just as well as code, and stops the question being
re-derived by the next pass.

## What this model does not cover

- The account-link protocol itself — #729
- Inbound content safety, prompt injection, and output guarding — the LLM
  Safety milestone
- Platform interaction as a boundary in its own right, and privileged
  operations beyond the learner-data surface above — gap 3 of
  `research/security-coverage-audit-2026-09-11.md` remains partly open

## Related

#915 (this deliverable), #693, #729, #641, #770, #856, #857, #877, #1000,
#690, #620, #1077, #1100, #691, and `data-catalog.md`.
