# Issue #742 — Messenger shared WISPACE token verification

Status: agreed during domain modeling and specification

## Problem Statement

From the learner's perspective, Messenger account linking should behave like
Discord and Zalo: the bot sends the opaque token link to WISPACE once, applies
the same security policy, and reports the same verification outcomes. Today the
Messenger bot owns a second token-verification implementation even though all
three bots call the same WISPACE endpoint and share the same failure taxonomy.

The duplicate implementation has already drifted from the shared client. The
shared client owns URL policy enforcement and `AbortSignal` support, while the
Messenger implementation has its own parser, timeout path, and logging. The
original issue's claim that Messenger reads the verify URL without validation
is stale at the current revision: the token verifier already goes through the
existing URL-policy helper. The remaining URL-policy gap is the generic
Messenger WISPACE client-config helper used by TaskScoreAverage and
UserCalendar, which still constructs a raw URL.

Messenger also receives POC `topic` and `cadence` fields that the shared result
does not currently expose. Removing the local implementation without preserving
those fields would change linking behavior and could write the wrong
notification settings to the mapping.

## Solution

Make the shared WISPACE token client the canonical HTTP and security boundary
for Messenger account linking, while keeping Messenger-specific POC behavior in
a thin adapter.

- Bind the shared token client for `platform: 'messenger'` through the
  Messenger linking module.
- Let a thin Messenger adapter preserve the existing caller contract and
  normalize/validate `topic` and `cadence`.
- Extend the shared success result with optional raw `topic` and `cadence`
  fields; the shared client only trims and exposes them and does not apply
  Messenger defaults.
- Make the existing generic WISPACE client-config helper validate the final URL
  (including fallbacks) with the canonical upstream URL policy before any
  TaskScoreAverage or UserCalendar request.
- Preserve the existing failure taxonomy, metric labels, token/value trimming,
  and token-only linking invariant.
- Support `AbortSignal` at the Messenger adapter boundary without changing the
  entire webhook pipeline in this issue.

## User Stories

1. As a learner, I want a valid opaque `m.me` token link to resolve to the WISPACE `userId` returned by WISPACE, so that account linking uses the authoritative identity.
2. As a learner, I want the bot to reject an unknown, expired, used, or malformed token with the established verification outcome, so that an invalid link cannot create a mapping.
3. As a learner, I want the Messenger link flow to send the same `{ token, value, platform }` contract as the other bots, so that WISPACE sees one consistent linking protocol.
4. As a learner, I want the PSID and token to be trimmed before verification, so that harmless surrounding whitespace does not change a valid link attempt.
5. As a learner, I want my WISPACE `userId` to come only from successful token verification, so that a `ref` value is never interpreted as an identity by the bot.
6. As a learner, I want an upstream `topic` in a successful verification response to be retained, so that my notification topic is not silently lost during consolidation.
7. As a learner, I want an explicit non-empty `topic` supplied by the Messenger link context to retain its current precedence, so that existing WISPACE-generated link behavior is unchanged.
8. As a learner, I want a missing or empty `topic` to use the existing `IELTS` default, so that a mapping always has the same safe POC topic as before.
9. As a learner, I want an upstream valid `cadence` to be normalized using the existing Messenger rules, so that `DAILY`, `WEEKLY`, and `MONTHLY` mappings remain stable.
10. As a learner, I want a missing or empty `cadence` to use the existing `WEEKLY` default, so that older WISPACE responses remain compatible.
11. As a learner, I want an invalid non-empty cadence to fail closed instead of silently becoming another cadence, so that notification frequency is never changed by malformed upstream data.
12. As a learner, I want the existing Messenger behavior where the incoming link context does not override the verified cadence to remain unchanged, so that WISPACE remains authoritative for cadence.
13. As a learner, I want an aborted or timed-out verification request to stop waiting for the upstream response, so that a webhook does not remain blocked after its caller no longer needs the result.
14. As a learner, I want unsafe WISPACE URLs to be rejected before a request is sent, so that my token and the internal key cannot be sent to an unintended host.
15. As a learner, I want TaskScoreAverage and UserCalendar requests to obey the same upstream URL policy as token verification, so that report and study-session data use the same outbound security boundary.
16. As a learner, I want a valid account-linking failure to retain its established classification, so that the bot gives the same safe linking response after the refactor.
17. As a learner, I want malformed success data without a positive WISPACE `userId` to fail closed, so that incomplete upstream data cannot create a partial mapping.
18. As a learner, I want upstream response bodies and token material not to appear in logs, so that account-linking secrets and learner data remain protected.
19. As a learner, I want a successful link to keep the same mapping and relink safeguards, so that consolidating the client does not weaken account ownership rules.
20. As a platform adapter owner, I want Messenger-only topic and cadence policy to remain outside the shared client, so that Discord and Zalo do not inherit Messenger-specific defaults.
21. As a platform adapter owner, I want the Messenger link-context caller to retain its existing verification contract, so that the refactor does not spread a signature change through webhook and link-flow code.
22. As a platform adapter owner, I want the shared client to be configured with an explicit platform discriminator, so that a Messenger request cannot accidentally be sent as Discord or Zalo.
23. As a platform adapter owner, I want the shared client to retain `AbortSignal` support when called through Messenger, so that future cancellation-capable callers do not need another HTTP implementation.
24. As an operator, I want the existing `TokenVerify` latency metric and `verify` operation label to remain available, so that dashboards and alerts do not lose continuity.
25. As an operator, I want URL-policy failures to occur before an outbound request, so that misconfiguration is visible as a deterministic startup/runtime configuration error rather than a vendor call.
26. As a maintainer, I want one shared implementation for request construction, URL policy, timeout, response parsing, and failure taxonomy, so that hardening one platform hardens all platforms.
27. As a maintainer, I want the old full Messenger verifier implementation and its imports removed, so that future changes cannot silently maintain two implementations.
28. As a maintainer, I want no feature flag or dual-run path for this internal refactor, so that there is only one production behavior to reason about.
29. As a maintainer, I want no database migration or environment-variable change, so that rollout is limited to code, tests, and documentation.
30. As a maintainer, I want the Messenger security and integration documentation to describe the shared-client boundary and thin adapter, so that future contributors do not reintroduce the duplicate.
31. As a maintainer, I want tests to prove external request and linking behavior at the highest existing seams, so that private parser structure can change without weakening the contract.
32. As a maintainer, I want Discord and Zalo behavior to remain unchanged, so that the shared-client extension is backward compatible for existing consumers.

## Implementation Decisions

- The shared `WispaceTokenVerifyService` remains the canonical WISPACE token
  verification client. Messenger binds it with the runtime platform value
  `messenger`, using the same metrics adapter pattern already used by Discord
  and Zalo.
- Messenger uses a thin adapter with the existing `verifyMessengerToken`
  caller contract. The adapter maps Messenger argument order to the shared
  client, forwards an optional `AbortSignal`, and returns the existing
  Messenger success/failure shape.
- The shared success result exposes optional `topic` and `cadence` strings as
  upstream metadata. The shared parser trims non-empty strings only; it does
  not import Messenger constants or apply Messenger defaults.
- The Messenger adapter owns the POC defaults and validation: `topic` falls
  back to `IELTS`, `cadence` falls back to `WEEKLY`, valid cadence values remain
  `DAILY`, `WEEKLY`, and `MONTHLY`, and an invalid non-empty cadence fails
  closed. The existing link-context topic precedence and verified-cadence
  authority remain unchanged.
- The shared client remains authoritative for token/value trimming, request
  payload, `X-Internal-Key`, URL policy, timeout, response envelope parsing,
  positive `userId` validation, and the failure taxonomy
  `NOT_FOUND | EXPIRED | USED | INVALID_FORMAT`.
- A recognized failure reason from either `reason` or `error` is returned as a
  normal verification failure. An unrecognized or unusable error response
  remains an internal failure; no raw upstream body is exposed.
- The shared client continues to log only a masked WISPACE `userId`. The old
  sanitized username log is intentionally not recreated because it is not
  part of the linking contract.
- The existing generic WISPACE client-config helper validates the final URL
  after applying an optional fallback. It uses `validateUpstreamUrl` and
  `buildUpstreamUrlPolicy`; this covers both TaskScoreAverage and UserCalendar
  callers without migrating those adapters to a different configuration
  service.
- Client construction remains lazy. Validation happens before the first
  outbound request, while the existing account-link startup checks remain in
  place.
- The adapter accepts `AbortSignal`, but no webhook caller is required to grow
  a new signal parameter in this issue. The shared request timeout still
  bounds every call.
- The old full Messenger token-verification service and all references to it
  are removed. No new generic port or feature flag is introduced for a single
  implementation.
- No WISPACE API, token lifecycle, mapping schema, database table, or
  environment-variable contract changes are included.
- The Messenger security and integration documentation is updated to describe
  the target shared-client boundary and the Messenger-only adapter behavior.

## Testing Decisions

- Tests assert external behavior and side effects, not private helper names or
  parser layout. A test should prove the outbound request, returned result,
  thrown error, signal propagation, or mapping-visible metadata that matters
  to a caller.
- The highest shared seam is the existing `WispaceTokenVerifyService` client
  contract. Extend its tests for Messenger platform payloads, optional
  metadata passthrough, signal forwarding, URL-policy rejection, positive
  `userId` validation, and the established failure taxonomy.
- The thin Messenger adapter is the second seam. Test topic precedence,
  defaults, cadence normalization, invalid-cadence rejection, argument
  mapping, failure passthrough, and optional signal forwarding without
  re-testing the shared HTTP parser in every case.
- The existing Messenger link-context tests remain the link-flow seam. They
  should prove that a valid verification still records the same context and
  intent, a failure preserves the existing outcome, and no token is verified
  twice by the current handoff logic.
- The existing URL-policy utility/config tests are the prior art for rejecting
  non-HTTPS, private, credential-bearing, fragment-bearing, or non-allowlisted
  URLs. Add coverage that the TaskScoreAverage and UserCalendar helper both
  validate their final env-or-fallback URL before client use.
- The existing Discord/Zalo module-factory wiring is the prior art for runtime
  platform binding and metrics injection. Messenger module tests should prove
  the shared client is bound with `messenger` and the adapter is the injected
  caller seam.
- Regression verification runs the shared package verification and Messenger
  verification commands. No live WISPACE request is required; mocked fetch
  tests are sufficient for the contract and security boundaries.
- The documentation-only edits need no runtime test; `git diff --check` must
  remain clean.

## Out of Scope

- Changing the WISPACE token-verification API, request payload, token lifecycle,
  or server-side ownership rules.
- Changing Messenger token-only linking, relink protections, verify-intent
  persistence, or mapping compare-and-set behavior.
- Migrating every Messenger WISPACE client to `WispaceConfigService`; this
  spec only closes the URL-policy gap in the existing generic helper.
- Adding a new feature flag, dual-run comparison, retry policy, or database
  migration.
- Propagating `AbortSignal` through the entire Messenger webhook pipeline.
- Restoring username logging or adding new learner-identifying log fields.
- Changing `topic` or `cadence` domain defaults, precedence, or notification
  semantics.
- Addressing timing-safe token comparison (#566) or any unrelated account-link
  security issue.
- Refactoring Discord or Zalo link flows beyond preserving compatibility with
  the shared result extension.
- Adding a new read-receipt, delivery-state, or upstream response-cache
  mechanism.
- Publishing a new ADR or changing the domain glossary; the vocabulary and
  architectural trade-off are already covered by existing documentation and
  this reversible refactor does not introduce a new bounded-context term.

## Further Notes

- The issue's original raw-URL statement should be treated as historical: the
  current Messenger token verifier already uses the existing verify-URL policy
  helper. The implementation work should update acceptance wording to describe
  the remaining report/calendar helper gap accurately.
- The accepted design deliberately keeps POC metadata at the Messenger
  adapter boundary. This prevents the shared WISPACE client from importing
  platform-specific notification rules while preserving the existing
  `MessengerLinkContext` contract.
- Implementation is complete on the working `main` branch. This specification
  records the agreed behavior and verification boundaries for issue #742.
