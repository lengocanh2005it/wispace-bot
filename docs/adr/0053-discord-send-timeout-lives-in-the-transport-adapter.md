---
status: accepted
---

# Discord send timeout lives in the transport adapter, not the SDK REST timeout

`#1509` asked for a configurable Discord send timeout matching the containment Messenger and Zalo already have. Reading the installed SDK first (`discord.js` 14.27.0, `@discordjs/rest` 2.6.3) showed the issue's premise was wrong on three counts, and the design below follows from what the code actually does.

**The premise was wrong.** The issue says "make Discord match Messenger", but Messenger's `keepAliveFetch` (`apps/messenger-bot/src/shared/http/http-agent.ts:40-42`) computes `timeoutMs ? AbortSignal.timeout(timeoutMs) : rest.signal` — whenever a timeout is configured it _discards_ the caller's signal. That is the same either/or defect this issue is about, one layer over, and it is already tracked as `#533`. Zalo's `AbortSignal.any` composition (`apps/zalo-bot/src/modules/zalo-chat/infrastructure/adapters/zalo-send-api.adapter.ts:30-31`) is the correct shape. Neither bot documents its send timeout in any `.env.example`, so the requested "documented in the bot's environment example" had no precedent line to copy.

**A deadline in `rest.timeout` is indistinguishable from any other abort.** `RESTOptions.timeout` (`@discordjs/rest/dist/index.d.ts:144`) drives a private `AbortController` inside `makeNetworkRequest` (`dist/index.js:742-748`) and calls `controller.abort()` with no reason, so the error reaching the application is always a bare `AbortError` regardless of cause. The deadline therefore lives in the transport adapter, which owns an `AbortSignal.timeout(...)` it can check after the fact and convert into a `DiscordSendTimeoutError`. `rest.timeout` is set to `DISCORD_SEND_TIMEOUT_MS * 2` purely as a backstop so the SDK's timer can never win the race; `rest.retries` is `0` so one application send is one HTTP attempt and the application retry loop is the only retry owner.

**The classification bug this issue actually had.** `isDiscordRetryableError` returned `false` for every abort, so a send that exhausted its own deadline was re-derived as a *cancellation* — terminal and unattributable — while `isAmbiguousDeliveryError` matched only `name === 'TimeoutError'`, a shape the SDK never produces. The ambiguous branch was therefore dead for the one case it existed to catch: a stalled send matched neither predicate, so the 08:00 report path lost the day's report to a terminal `DELIVERY_FAILED`. The adapter now owns the deadline and names the cause with a `DiscordSendTimeoutError` the application predicates can key off.

**A stalled send is ambiguous, not retryable.** This is the point the earlier draft got backwards. There is no delivery verdict when the deadline expires, so the provider may already hold the message; a resend risks a duplicate, which is exactly what [GLOSSARY.md](../GLOSSARY.md) forbids for an ambiguous delivery. Zalo draws the same line at `httpStatus === 0`. ADR-0033's LLM rule ("a per-attempt timeout is retryable") does **not** transfer here: an LLM call is idempotent and a chat message is not, so the same timeout is safe in one boundary and unsafe in the other. `isDiscordRetryableError` keeps returning `false` for aborts, and `isAmbiguousDeliveryError` matches the typed error instead of an error name.

## Consequences

- The adapter reads `DISCORD_SEND_TIMEOUT_MS` (default `15000`, matching the previous effective behaviour) and the value lives in `domain/discord-send-timeout.ts` so the client factory can read it without the application module depending downward on an infrastructure adapter. This is config in the infrastructure layer; the application layer still owns retry, classification and journaling.
- `DiscordTransportPort` gains no new surface: no `signal` parameter, no new result type. The earlier draft threaded a caller signal through every send path with no consumer; it was removed rather than kept as speculative plumbing.
- A stalled send is classified `ambiguous` and recorded with its own metric label, `dm_send_ambiguous_timeout`, so a timeout is distinguishable in dashboards from a network-level ambiguous failure (`dm_send_ambiguous`). The 08:00 report path records it as sent rather than losing the day's report to a terminal `DELIVERY_FAILED` (`discord-report-delivery.service.ts:120-131`).
- The stable nonce plus `enforceNonce` (`discord-outbound.service.ts:508`) is what makes an ambiguous report re-send safe, and it remains the reason `retryAmbiguous: true` is Discord-specific in the dead-letter cron.

## Rejected alternatives

- **Making the timeout retryable.** It is the intuitive reading of ADR-0033 and it is wrong here: with no delivery verdict, the second attempt can deliver a second copy. `withRetry` would also short-circuit on `isAbortError(error)` before consulting `shouldRetry` (`packages/wispace-client/src/utils/with-retry.ts:44-49`) unless the typed error were threaded past it, which is a second reason to leave the predicate alone.
- **Reusing `perAttemptTimeoutMs` on `retryWithBackoff` for the deadline.** It composes the deadline into the single signal handed to the adapter, so the adapter sees one already-aborted signal and cannot tell a timeout from a cancellation — the distinction the issue exists to make.
- **Swapping `withRetry` for `retryWithBackoff` to gain per-attempt timeouts.** Without the signal plumbing they are behaviourally identical here (no `perAttemptTimeoutMs`, no `signal`), so the swap bought nothing and pulled a non-LLM path into `@wispace/llm-agent/core` for no gain.
- **Threading a caller `signal` through the port.** No Discord send path has one. It was speculative API surface, and it made the retry helper swap look necessary when it was not.
