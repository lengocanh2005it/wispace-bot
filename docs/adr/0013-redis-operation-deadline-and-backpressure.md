# Redis operation deadlines and backpressure

**Status: accepted**

The shared Redis client treats every operation as bounded: command and connect deadlines are configured at boot, commands issued before readiness are rejected, and a derived socket deadline closes a silent connection so ioredis cannot retain an unbounded in-flight command queue. Unfulfilled commands are not automatically resent after reconnect; reconnect continues in the background with ioredis' capped exponential+jitter strategy, while callers retain ownership of idempotency, fencing, and retry decisions because a timeout creates an unknown Redis outcome.

Timeouts are exposed as typed errors and low-cardinality metrics; caller cancellation remains distinct. A failed initial ping disconnects the client before it is discarded, and the existing readiness/API semantics are otherwise unchanged. This keeps silent Redis from stalling chat and other hot paths without adding a second queue or a cross-context retry policy.

## Considered options

- **Keep ioredis' offline queue and resend unfulfilled commands:** rejected because a disconnected or silent Redis can retain work indefinitely and a late write result is not safe to replay generically.
- **Add a bespoke bounded Redis command queue:** rejected because ioredis' `socketTimeout` already clears the native queue while preserving the shared client boundary.
