---
status: accepted
decided: 2026-09-27
issue: 1346
---

# Contract ownership taxonomy

A contract that a deciding context, an applying context, and a recording
context all read is cross-context and is declared once in `@wispace/contracts`.
A state whose meaning is private to one context's own rows stays with that
context. Applying that test moved the chat quota deny and release reasons to
the shared kernel and left the chat idempotency status where it was.

## Context

The repository carried two claims in one sentence: `@wispace/contracts` is the
canonical owner of cross-context contracts, and the chat-quota contracts live
in `@wispace/chat-metering`. #1346 read that as a contradiction and proposed
moving all three types.

It was not a contradiction. `CONTEXT-MAP.md` defines Metering & Operations as a
bounded context that owns `packages/chat-metering`, and its first boundary rule
says a context owns its own domain types. The placement was correct and the
issue's premise was not — but the issue had still found something real, just
elsewhere.

`ChatQuotaDenyReason` was declared three times, and the third declaration held
only two of the four reasons. The resulting type error was suppressed at the
recorder call site by an inline assertion, and a comment beside it stated that
the core never returns `IDEMPOTENCY_CONFLICT` on that path. It does, from the
same call the comment describes. The written data was correct the whole time —
the recorder forwards the reason into the audit payload — so nothing warned,
and the assertion spelled the union out by hand rather than naming either
declaration, so a rename would have left it silently mistyped.

A second source of truth inside one bounded context is a defect regardless of
which package owns the type. The guard belongs to ownership, not to the move.

## Outcome (#1346)

`ChatQuotaDenyReason` and `ChatQuotaReleaseReason` moved to
`packages/contracts`. A core decides with them, an application applies them to
a learner-facing outcome, and the audit table records them, which is what makes
them cross-context.

`ChatIdempotencyStatus` stayed in `packages/chat-metering`. It is the lifecycle
of a `chat_idempotency` row, and no other context interprets it. The same test
that moved the two taxonomies is what left it alone.

The `contracts-owned-type-single-declaration` rule in
`scripts/check-architecture.mjs` fails the build when either taxonomy is
declared in any other TypeScript file, specs included. It lives inside
`architecture:check` rather than beside the shell guards in `.github/scripts/`
because it is a declaration rule rather than an import edge, and because it
then runs in the same command as the lint and typecheck that a reader is
already looking at, instead of in a second job whose failure reads as unrelated
to the change that caused it.

## Why not the database package for the status

The repository's own rule already puts a state that exists because a table
exists beside the schema. `ChatIdempotencyStatus` is not that: it encodes a
state machine that drives reserve, deliver, complete, and refund. And the
choice would not have been available — `databaseRoleViolation` in
`scripts/check-architecture.mjs` bans a shared package from importing
`@wispace/database` outside its own `src/adapters`, so hosting it there would
have meant making the metering core reach the database package.

## Why no compatibility re-export

The metering package published both names from its `/core` entrypoint, and
Messenger read them from there. A staged ratchet — move, re-export, then delete
the re-export in a second change — would have bought nothing: the workspace
compiles as a unit, the names are type-only with no runtime effect, and
`npm run verify` runs `knip:deps`, which excludes the unused-export analysis, so
a re-export would not have produced a warning and a second change would have
proven nothing. Re-exporting a contract from a context package is also the
coupling the architecture rules already forbid, so the re-export was removed
outright rather than kept and forgotten.

## Consequences

- A hand-written union is a hole in the guard. A site that spells the reason set
  out instead of naming the type exports no guarded name, so the four inline
  copies the dedupe found were replaced before the move rather than after it. A
  narrow type at a call site is legitimate — the core's own deny logger and the
  learner-facing message are both narrowed — but the narrowing must be held by
  control flow that proves it, never by a cast.
- Adding a fifth denial reason now fails nothing on its own; the message surface
  derives its set from the contract, so the compiler asks whether there is copy
  for the new reason.
- Placement questions for future contracts have an answer to consult rather than
  a fresh argument. The glossary entries for the two concepts that were missing
  make the set of three readable as a set.

## References

- [ADR-0027 — Stable identity buckets for daily chat quota](0027-chat-quota-identity-buckets.md)
- [ADR-0042 — Platform storage metadata registry](0042-platform-storage-registry.md)
- [CONTEXT-MAP.md](../../CONTEXT-MAP.md)
- [#1346](https://github.com/lengocanh2005it/wispace-bot/issues/1346)
