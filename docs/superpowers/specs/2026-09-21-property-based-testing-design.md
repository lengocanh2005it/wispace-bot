# Property-Based Testing Expansion

## Goal

Expand the existing `fast-check` coverage for deterministic boundaries and
stateful policies that have strong, non-tautological properties. Keep the
change test-focused and preserve the current package boundaries.

## Scope

Add or extend property suites for:

- `canonicalizeToolArguments`: recursive object-key order invariance and array-order preservation.
- AES-GCM helpers: arbitrary plaintext roundtrip, key separation, and envelope tamper rejection.
- User calendar normalization: alias equivalence, normalization stability, valid-array preservation, and fail-closed invalid rows.
- LLM input/tool-result sanitization: bounded output, JSON preservation, repeated sanitization stability where applicable, and injection/secret non-leakage.
- Cookie parsing: arbitrary-header totality, first duplicate wins, malformed percent-encoding fallback, and prototype-pollution resistance.
- Clarification parsing/state: text normalization idempotence, bounded histories, monotonic versions, stale-event rules, and configured limits.
- Report/date utilities: local-day invariants across supported and extreme IANA timezones, including DST boundaries.
- Messenger/Zalo event IDs: bounded deterministic IDs, semantic key-order invariance for content fingerprints, and precedence rules.
- Upstream URL validation: generated policy/URL combinations obey transport, credential, fragment, private-host, and exact-allowlist rules.
- Debounce queue: generated command traces preserve per-user isolation, ordering, caps, promotion, and drain behavior without real-timer randomness.

Existing property suites remain unchanged unless a shared generator or
contract assertion needs a focused extension.

## Production fixes allowed by failing properties

Only contract defects exposed by the new tests may change production code:

1. Canonicalize Zalo fallback event-ID input before hashing so equivalent JSON
   object key order produces the same ID.
2. Replace the fixed-noon probe in `tomorrowInTimezone` with a date-safe
   calculation that returns exactly the next local calendar date for supported
   IANA timezones, including offsets near +/-14 hours.

No public API, persistence schema, or external protocol changes are planned.

## Test design

- Reuse the root `fast-check` dependency (`^4.9.0`).
- Generate valid domain values directly. Avoid broad `filter` calls that make
  a property vacuous.
- Use small bounded runs consistent with the existing 200-run suites.
- Keep each property focused on one invariant and make failure output shrinkable.
- Use deterministic fake timers or a command model for `DebounceChatQueue`.
- Do not assert ciphertext equality because AES-GCM uses a random IV.
- Treat known timezone behavior as a contract to fix, not as a permanently
  documented failing property.

## Verification

1. Run `npm ci`, then focused tests for each touched workspace.
2. Run repository gates in order: `npm run format:check`, `npm run lint`,
   `npm run typecheck`, `npm run test`, `npm run build`.
3. Inspect the final diff and staged content for unrelated changes and secrets.
4. Commit the implementation on `main` with a concise `test:` message.

## Out of scope

- Direct property fuzzing of database, HTTP, LLM-provider, or NestJS orchestration.
- New testing libraries or a shared cross-package generator framework.
- Queue implementation redesign beyond fixes proven by the model-based tests.
- Unrelated cleanup, formatting, or documentation campaigns.

## Risks

| Risk | Mitigation |
| --- | --- |
| Timezone generators expose ambiguous DST behavior | Assert calendar-date invariants and use known IANA zones with explicit boundaries. |
| Queue properties become flaky | Use fake timers/model traces; keep real-time tests unchanged. |
| Security generators overfit the current regex list | Assert bounded/no-leak invariants in addition to known injection examples. |
| A property exposes an intentional compatibility behavior | Classify it before changing production code; update the contract only with evidence. |
