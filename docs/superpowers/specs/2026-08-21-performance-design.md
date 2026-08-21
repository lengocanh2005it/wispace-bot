# Design: Performance — #263 + #267

## Scope

| Issue | Title | Status |
|-------|-------|--------|
| #263 | Avoid DB token lookup per Zalo outbound | In scope — expiry-aware cache |
| #267 | Bound Messenger webhook inbound persistence concurrency | In scope — p-limit |
| #272 | Bound webhook backlog count query | **Skipped** — already capped at 10,000 |

## #263: Expiry-aware Zalo token cache

### Problem

`ZaloTokenService.getValidAccessToken()` does `findOne` on every outbound send. Token is valid 1 hour; cache would eliminate ~99% of lookups.

### Fix

Add an in-process cache that stores the token with its actual `expires_at`. On access, check if cached token is still fresh (with a 10-min buffer). On miss or stale, read from DB. On DB read, update cache. The existing `isFresh()` check already handles the buffer.

### Files changed

- `apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-token.service.ts` — add in-process cache
- `apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-token.service.spec.ts` — **new or update** tests

## #267: Bounded concurrency for webhook persistence

### Problem

`Promise.allSettled(events.map(...))` fires all DB inserts unbounded. N events = N simultaneous inserts.

### Fix

Use `p-limit` with `concurrency: 5` to cap parallel inserts. `Promise.allSettled` still processes all events; p-limit just caps parallelism.

### Files changed

- `apps/messenger-bot/src/modules/messenger/application/services/messenger.service.ts` — add p-limit
- `apps/messenger-bot/package.json` — add `p-limit` dependency (if not already present)

## What does NOT change

- Webhook inbound event service — no changes.
- Backlog count query (#272) — already capped, skipped.
