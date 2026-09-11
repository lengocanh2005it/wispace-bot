# Security coverage audit — 2026-09-11

## Purpose

This is the current whole-repository security coverage index for wispace-bot.
It replaces the stale docs/security-audit-report.md and is indexed from GitHub
issue [#693](https://github.com/lengocanh2005it/wispace-bot/issues/693).

This review is a read-only static audit of source, tests, operational scripts,
documentation, and the open-issue tracker. It is not a penetration test, live
provider assessment, dependency scan, or production incident review.

## Executive result

- No single bounded context is completely unreviewed. The strongest component
  coverage is in free-form chat safety, study-reminder persistence, metering,
  and deployment regression scripts.
- No context has all three layers of end-to-end evidence, threat model, and
  data-lifecycle/erasure verification. The largest remaining risk is the
  learner journey from identity linking to WISPACE access and scheduled
  outbound delivery across all three platforms.
- Existing hardening is substantial: webhook authentication and raw-body
  verification, OAuth state/PKCE protection and encryption at rest, upstream
  TLS/SSRF validation, request validation and security headers, prompt/history
  sanitization, bounded LLM admission, retry jitter, circuit-breaker
  classification, secret-safe telemetry, deployment fencing, Vault bootstrap,
  immutable image pinning, and backup/restore verification.
- No generic new “security audit” issue is needed. Use #693 as the index and
  the scoped issues below as implementation owners.

## Coverage matrix

| Context | Code/tests | Threat or data-flow coverage | Remaining confidence gap |
| --- | --- | --- | --- |
| Platform interaction | Webhook/gateway unit and Messenger HTTP contract coverage | Partial | No automated cross-platform ingress → outbound E2E |
| Account linking | Strong service/controller coverage for Messenger, Discord, and Zalo | Partial; platform-specific flows remain | Full link → verify → mapping → access journey and relink/id-reuse threat model |
| Learning-data ACL | WISPACE client, capability-port, and tool tests | Partial | No consumer/upstream ownership contract gate or ACL-focused E2E |
| Free-form chat | Strong pipeline, safety, history, queue, and eval component tests | Partial | Production-composition E2E and relink/pod-restart isolation |
| Study reminders | Shared-core unit tests plus real SQL delivery smoke | Partial | WISPACE → job → provider delivery E2E and recipient-authorization threat model |
| Student reports | Core/formatter/failover tests | Partial | Adapter/delivery lifecycle and report-data-to-LLM threat/data-flow review |
| Metering and privileged ops | PostgreSQL/Redis smoke, quota, lease, metrics, and HTTP contract tests | Partial | Fleet operator journey, authorization scope, audit trail, reconciliation, erasure |
| Deployment and supply chain | Script regression, Vault, image, migration, health, backup/restore tests | Partial | Provenance/signature enforcement, canary promotion, and full DR exercise |

## Controls verified during this review

### Trust boundaries and identity

- Messenger and Zalo webhook authentication preserve raw request bytes before
  HMAC verification; invalid signatures fail closed.
- OAuth state and PKCE material is encrypted at rest with per-row IV/tag
  formats; invalid or legacy plaintext state/token rows fail closed.
- Discord and Zalo link completion persist a durable verify intent before the
  local mapping commit and use compare-and-set/reconcile fences for crash and
  relink races.
- WISPACE client configuration rejects unsafe URLs, credentials, fragments,
  private production targets, and non-allowlisted hosts.
- HTTP validation, Helmet/security headers, internal API guards, and bounded
  request bodies are applied at the application boundary.

### LLM and data handling

- Free-form input, stored history, and tool results pass through the same
  injection/sanitization path before an LLM call.
- Safety telemetry stores a redacted excerpt, hash, and length; it does not
  persist raw learner text.
- Reminder times and report facts are server-derived; model output cannot
  override scheduling or deterministic facts.
- LLM admission is bounded across bots/features, aborts propagate to provider
  calls, retry delays use shared jitter, and overload/deadline errors do not
  retry blindly.

### Operations and delivery

- Send-API and WISPACE circuit breakers trip only for transport, timeout,
  rate-limit, and 5xx classes; deterministic user 4xx failures do not exhaust
  the fleet breaker.
- Durable webhook/reminder/report jobs use leases, terminal/deferred outcomes,
  bounded retry windows, and dead-letter/recovery paths.
- Public liveness/readiness endpoints expose status only; detailed dependency
  health is internal-key protected.
- Deploy scripts fail closed on image, migration, backup, Vault, nginx, and
  health-gate failures; image pulls use immutable digests where available.
- Gitleaks, pinned actions/images, migration fencing, encrypted offsite backup,
  and guarded restore verification are present in CI/deployment paths.

## Residuals and canonical issue owners

### Identity, privacy, and learner isolation

- [#856](https://github.com/lengocanh2005it/wispace-bot/issues/856),
  [#857](https://github.com/lengocanh2005it/wispace-bot/issues/857), and
  [#877](https://github.com/lengocanh2005it/wispace-bot/issues/877) track
  post-relink/pod-restart state isolation, cache identity, and erasure edges.
- [#999](https://github.com/lengocanh2005it/wispace-bot/issues/999),
  [#995](https://github.com/lengocanh2005it/wispace-bot/issues/995), and
  [#1041](https://github.com/lengocanh2005it/wispace-bot/issues/1041) track
  newer identity/privacy boundary follow-ups found in the tracker.
- [#729](https://github.com/lengocanh2005it/wispace-bot/issues/729) is the
  canonical account-link establishment threat-model owner: token binding,
  replay/expiry, callback identity, relink/id reuse, and partial/unverified
  mappings.
- [#915](https://github.com/lengocanh2005it/wispace-bot/issues/915) remains
  separate and owns downstream WISPACE reads, reports/LLM, reminders,
  cache/history reuse, delivery, and privileged flows after mapping exists.

### Privileged operations and auditability

- [#770](https://github.com/lengocanh2005it/wispace-bot/issues/770) is the
  canonical owner for capability-scoped ops authorization, caller identity,
  rotation, and target authorization.
- [#641](https://github.com/lengocanh2005it/wispace-bot/issues/641) owns the
  append-only privileged audit trail; [#485](https://github.com/lengocanh2005it/wispace-bot/issues/485)
  owns destructive-operation throttling/idempotency.
- [#488](https://github.com/lengocanh2005it/wispace-bot/issues/488),
  [#701](https://github.com/lengocanh2005it/wispace-bot/issues/701), and
  [#702](https://github.com/lengocanh2005it/wispace-bot/issues/702) cover
  adjacent ops/export/privacy execution gaps.

### LLM data boundary and provider governance

The remaining tracker work is distributed across
[#632](https://github.com/lengocanh2005it/wispace-bot/issues/632),
[#503](https://github.com/lengocanh2005it/wispace-bot/issues/503),
[#560](https://github.com/lengocanh2005it/wispace-bot/issues/560),
[#832](https://github.com/lengocanh2005it/wispace-bot/issues/832),
[#859](https://github.com/lengocanh2005it/wispace-bot/issues/859),
[#620](https://github.com/lengocanh2005it/wispace-bot/issues/620),
[#353](https://github.com/lengocanh2005it/wispace-bot/issues/353), and
[#885](https://github.com/lengocanh2005it/wispace-bot/issues/885). These cover
retention/zero-training evidence, prompt and tool-data boundaries, provider
configuration, report data flow, and remaining safety/eval enforcement.

### Supply chain and enforcement

Track provenance/signature enforcement, dependency/image findings, and CI
policy gaps through
[#643](https://github.com/lengocanh2005it/wispace-bot/issues/643),
[#964](https://github.com/lengocanh2005it/wispace-bot/issues/964),
[#965](https://github.com/lengocanh2005it/wispace-bot/issues/965),
[#551](https://github.com/lengocanh2005it/wispace-bot/issues/551),
[#935](https://github.com/lengocanh2005it/wispace-bot/issues/935),
[#550](https://github.com/lengocanh2005it/wispace-bot/issues/550),
[#1032](https://github.com/lengocanh2005it/wispace-bot/issues/1032), and
[#359](https://github.com/lengocanh2005it/wispace-bot/issues/359).

## Overlap cleanup completed

- **#486 → #770:** #486 is closed as superseded; #770 is the single owner for
  shared internal-API key blast-radius reduction and authorization scoping.
- **#566 → #810:** #566 is closed as superseded; #810 owns the shared
  constant-time secret comparison, including Messenger hub.verify_token.
- **#729 ↔ #915:** both remain open with an explicit boundary. #729 owns link
  establishment and identity binding; #915 owns downstream data consumers and
  scheduled outbound flows.
- **#693:** remains the coverage index. This report is its current artifact.

## Gaps without a clearly scoped open issue

These are coverage findings, not reasons to open another generic audit issue:

1. There is no automated three-platform learner journey covering link →
   verified identity → WISPACE read → report/reminder/chat → outbound delivery.
2. There is no authoritative, repository-wide data catalog that maps every
   persisted field to source, owner, retention, and erasure behavior.
3. Threat models are uneven: account linking has the clearest dedicated scope,
   while platform interaction, reminder recipient authorization, report data
   flow, and privileged operations are mostly distributed across code/docs.
4. packages/ops-health remains an architecture seam that should be reconciled
   with the runtime health implementation before adding more alert consumers.

## Credential-handling red flag

The workspace contains three ignored apps/*-bot/.env files with Vault AppRole
bootstrap material and matching role/secret values. No raw values are copied
into this report. If these are real or reusable credentials, revoke/rotate them
and re-bootstrap through the Vault runbook. This review made no credential
changes.

## Recommended next sequence

1. Finish #729's identity invariants, then use them as explicit preconditions
   in #915's downstream ACL/data-flow review.
2. Add one cross-platform learner-journey E2E harness, starting with a fake
   upstream and real PostgreSQL/Redis, then add provider delivery adapters.
3. Close the data-catalog/erasure gap alongside #641, #770, #877, and the
   existing privacy issues rather than creating another umbrella issue.
4. Enforce provenance/signature policy and run a canary/restore drill through
   the existing supply-chain and DR issues.
