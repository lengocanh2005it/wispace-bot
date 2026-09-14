# Chat runtime environment resolution contract

## Status

Accepted.

## Decision

Chat queue and history runtime settings are resolved once at startup into an
immutable, framework-free `ChatRuntimeConfig` snapshot. The same resolver is
used by the Messenger, Discord, and Zalo consumers and by the operations CLI;
consumers do not read `process.env` again. Explicit `memory`/`redis` values win.
Blank or unknown store values fall back to the legacy `CHAT_QUEUE_SHARED`
alias (`true`/`1`/`yes`), then to `memory`. Queue and history stores remain
independent. Platform history prefixes select the platform-specific numeric
settings; the existing global `CHAT_HISTORY_STORE` remains the fallback for
platforms without a prefixed store, while Redis key prefixes remain
composition-root wiring.

`CHAT_DEBOUNCE_MS` defaults invalid, infinite, or negative values to 2 seconds,
accepts zero, floors positive values, and caps them at 10 seconds.
`CHAT_MAX_PENDING_MESSAGES` uses 20 by default, floors positive values, treats
zero as unlimited, and defaults invalid or negative values. A positive
`CHAT_QUEUE_PROCESSING_STUCK_MS` is floored; all other values use 300 seconds.
History defaults to a 30-minute TTL, 20 messages, and 10,000 users. Production
store requirements and Redis availability checks remain startup policies, not
parser behavior.

## Consequences

The legacy alias remains compatible without being another source of truth, and
the queue pending cap is identical for memory and Redis. Parser tests cover the
mode/alias/invalid matrix, numeric edge cases, CLI parity, and the immutable
snapshot. Queue lock TTL, stale/cleanup intervals, flush-retry settings, and
chat-metering strict/lenient quota policy remain outside this contract; existing
post-boot failure semantics are unchanged.
