# Redaction: what may be written where

Three sinks, one identity rule, one credential registry. Read when writing a log
line, formatting text that came from a learner or WISPACE, building a
system-prompt part, or recording telemetry. Secret _delivery_ (local `.env` vs
Vault) is `docs/vault-secrets.md`; git hygiene is `CODING_STANDARDS.md`.

## Identity masking at the call site

External identities (Messenger PSID, Discord ID, Zalo ID, WISPACE `userId`) are
masked with `maskExternalId(id)` from `@wispace/bot-common` — first 4 + `…` +
last 4, `???` for missing — in every log line, every thrown error message, and
every persisted error string (`last_error`, `error_message`).

- Composite inbox event ids (`pb:<psid>:<payload>:<ts>`) are masked with
  `maskEventId(eventId, externalUserId)`. Dedupe keys stored in the database are
  unchanged; only the log line is masked.
- Link-token material is logged as absent, prefixes included — a verify-success
  log carries the masked `userId` and nothing token-shaped.
- Externally sourced usernames and API body text pass through `sanitizeLogValue`
  (strip control characters, cap the length) before masking.

Deliberately unmasked, so a reader knows the boundary is intended: structured ops
API responses, DB correlation keys (`mid`, `correlationId`, idempotency keys),
trace span attributes, and raw payloads stored for recovery — those are bounded by
the retention crons in `docs/project-overview.md` §6.

CI guard `node .github/scripts/check-log-redaction.js` checks **each template
interpolation separately**: every expression containing
`${psid|externalUserId|discordUserId|zaloUserId|externalId|discordId|zaloId}` must
itself call `maskExternalId(...)`, `maskEventId(...)` or
`maskExternalIdInText(...)`. An unrelated helper such as `errorMessage(...)`
elsewhere in the same logger call does not satisfy it. Wrapping the complete first
argument in `redactLogLine(...)` counts as a whole-line mask.

## The structural layer (#610)

All three bots boot with `RedactedLogger` (the Nest `logger:` option, i.e.
`app.useLogger`-grade), so every line passes `redactLogLine`, which masks digit
runs ≥15 — PSIDs and snowflakes, while 13-digit epoch-ms stays readable — even
when a call site forgets to mask. Two passes in a fixed order:

1. registered runtime secret values, exact match (`#632`);
2. digit runs.

Order matters: the registered-value pass has to run first, or an all-digit
secret is mangled by the digit pass and no longer matches. Non-string payloads
are covered too — `RedactedLogger` serialises objects and errors with `inspect`
before redacting, so passing an `AxiosError` no longer hands `err.config` to the
console unmasked.

Shared components that take a `{ warn, error }` port instead of a Nest
`LoggerService` get `consoleRedactedLogger` from `@wispace/bot-common/logging`. A
bare `console.warn(message)` in such a component has neither id masking nor
secret redaction.

## One credential registry, three sinks (#632)

`CREDENTIAL_SHAPES` and the runtime-secret registry live in
`packages/bot-common/src/masking/credential-shapes.ts`, and the registry read
lives with them.

| Sink                                            | Primitive                      | Rule                                                                                                                                                                  |
| ----------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| model context + safety telemetry                | `redactCredentialText`         | registry first, then shapes                                                                                                                                           |
| `errorMessage` (persisted/logged error strings) | `redactRegisteredSecretValues` | registry only, exact-value, idempotent; keeps its own context-preserving patterns (`password=[REDACTED]` keeps the key name, the canonical assignment shape does not) |
| telemetry PII layer                             | `redactSafetyText`             | the shared primitive plus a telemetry-only PII layer — long opaque tokens, PEM, emails, VN phone. Credential shapes are not re-listed here                            |

Adding a credential shape means editing `CREDENTIAL_SHAPES` once.

**No-secrets zone.** Prompt, tool schema and tool results are a no-secrets zone
enforced at the boundary: `redactSecrets` (shapes via `CREDENTIAL_SHAPES` plus
runtime values registered per-app at boot) runs inside the sanitizers and on
every system-prompt suffix. The audit table is in `.claude/rules/prompts.md`.

Two boundaries are separate on purpose, and that is what keeps turn 1 and turn 2
from disagreeing:

- the **current** user turn keeps its text intact — `detectPromptInjection`
  blocks an injection before it reaches the provider (#1047) — so only secret
  redaction applies there;
- every later replay from history runs the full `sanitizeUntrustedTextForLlm`.

Dynamic system-prompt parts go through `redactPromptPart` →
`sanitizeUntrustedTextForLlm` (secret **and** injection, because the system
message outranks the user turn), collapsing a tripped pattern to the neutral
`Chào bạn nha` rather than a redaction marker.

## Telemetry stores hashes, not text

`LlmSafetyCore.recordGroundingWarning` / `recordInjectionEvent` persist a
sanitized excerpt only — control characters stripped, credential-like patterns
replaced with `[REDACTED]` — plus a SHA-256 hash and the original length.
`llm_safety_events` never holds raw user text, assistant text, tool data, or
error fields. `isInjectionSanitizeReason` gates event emission: a benign
`secret_redacted` or a length trim is not an injection event.

External identities do not enter metrics, alerts or events. Metrics carry bounded
labels (`platform`, `outcome`, `store`, `operation`); masked external ids may
appear in logs under the rule above.

## Prompt canary (#1285)

The process-scoped canary enters model context only as the data-only
`Process marker: <value>` part. The canary value, the raw reply, and raw reply
content stay out of logs, history, safety events, metrics, alerts and every other
persisted sink. Report and reminder canaries do not exist, and the canary is not a
core prompt rule.

## Transient link tokens at rest

OAuth state secrets and Zalo OA tokens are encrypted with AES-256-GCM and a
per-row IV, stored as `v1.<iv>.<tag>.<cipher>` in `discord_oauth_states`,
`zalo_oauth_states` and `zalo_oa_tokens`.
`OAUTH_STATE_ENCRYPTION_KEY` / `DISCORD_OAUTH_STATE_ENCRYPTION_KEY` /
`ZALO_OAUTH_STATE_ENCRYPTION_KEY` (32-byte base64, from Vault/AppRole) protect the
transient link tokens and PKCE verifiers; an invalid or plaintext row fails
closed. `ZALO_TOKEN_ENCRYPTION_KEY` encrypts the Zalo OA access and refresh
tokens — re-bootstrap them with `apps/zalo-bot/docs/zalo-oa-token-bootstrap.md`
after a rotation.

Expired-but-unconsumed OAuth states are cleaned **opportunistically on each
`create()`** — one bounded `DELETE … WHERE created_at < NOW() - TTL LIMIT 100`,
strictly older than the TTL so an in-flight valid callback is never deleted. There
is no cleanup cron for them (#420).

## Secrets in the repository

`docs/project-overview.md` §13 is the authority: secrets arrive from `.env` /
`.env.shared` locally and from Vault in production, the repo carries
`.env.example` only, and containers mount no `.env`. CI runs Gitleaks on push and
PR with a failing policy. If a local env file is ever exposed, the rotation
procedure is `docs/project-overview.md` §13 "Recovery procedure".
