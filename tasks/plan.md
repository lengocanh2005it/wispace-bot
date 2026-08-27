# Implementation Plan: Issue #401 clarification hardening

Issue #401 is the task tracker. This follow-up closes the remaining acceptance
criteria without adding a second persistence model.

## Task List

### Phase 1: Delivery safety
- [x] Add clarification reply delivery identity and retry-safe state transitions.
- [x] Emit clarification delivery-failure/state-store telemetry with redacted logs.

### Phase 2: Identity and locale coverage
- [x] Invalidate clarification state on every relink/unlink lifecycle path.
- [x] Expand deterministic locale aliases only where tests demonstrate a gap.

### Phase 3: Evidence
- [x] Add issue-specific evaluation fixtures and focused tests for replay, races, privacy, batches, and platform isolation.
- [x] Run affected format, lint, typecheck, test, and build checks.

## Risks

- Provider APIs differ in outbound idempotency support; use existing platform
  delivery keys where available and fail closed for ambiguous outcomes.
- No new database migration is planned; Redis is required in production and the
  bounded memory store remains a local/test fallback only.
