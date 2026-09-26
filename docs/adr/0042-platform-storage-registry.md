---
status: accepted
decided: 2026-09-26
issue: 1079
---

# Platform Storage Metadata Registry

Per-platform mapping-table, mapping-key-type, verify-intent-table,
verify-intent identifier-column, and status-column metadata live in one
registry in `@wispace/contracts`, exhaustively keyed by the `Platform`
contract, and every site that chose a table, a column, or a status literal by
testing a platform name now reads it from there. A persistence detail living in
a package named for contracts is deliberate, not an oversight: the alternative
owners cannot be read by every consumer.

## Outcome (#1079)

`PLATFORM_STORAGE` is keyed by `Platform`, which is now derived from a runtime
`PLATFORMS` constant so the vocabulary has exactly one declaration. Two
packages consume it — `@wispace/database` and `@wispace/study-reminder-shared`
— and the three duplicated table maps plus five platform-name branches are
gone. `.github/scripts/check-platform-storage-literals.sh` fails the build when
a platform literal reappears in the covered files, so the registry cannot decay
back into branches during an unrelated refactor.

The canonical terms are **platform storage** (the registry),
**platform storage descriptor** (one platform's entry), and **platform mapping
table** (the table itself). "Platform capability metadata" is not used: the
repository already uses *capability metadata* for the LLM tool classification
vocabulary.

## Why not the database package

`@wispace/database` is the correct owner of table names by the repository's own
rule, and it is where entities and migrations live. It cannot host this
registry, because `@wispace/study-reminder-shared` does not depend on it — by
design, since shared packages reach the database only through their adapter
subpaths. That boundary is worth more than the tidiness of colocating a string
with its schema, and the registry is exactly the kind of cross-context fact
that boundary is meant to force into the shared kernel.

## Alternatives

- **Put it in `@wispace/bot-common`.** Rejected: it would split one concept
  across two packages, since `bot-common` does not own the `Platform` contract
  that the descriptor is keyed by. It remains the right home for per-platform
  *lock identifiers*, which already have a registry there and a dedicated issue.
- **Create a `platform-storage` package.** Rejected for now: a new workspace
  costs build wiring and an architecture-rule update for a single constant, and
  moving one file later is cheap. Revisit if a fourth consumer appears that
  cannot depend on `@wispace/contracts`.
- **Generate the canonical-platform SQL from the registry.** Rejected for this
  change: it would alter the learner link-state read path, which this issue
  promised not to change. The parity between that literal SQL and the registry
  is held by the guard instead; generating it is a possible follow-up once the
  registry has settled.

## Consequences

- Redis key prefixes, privacy cleanup store sets, canonical platform priority
  order, and advisory lock identifiers are **not** in the registry. They are the
  same shape — a platform name choosing a value — but a different concern, and
  folding them in turns this into a repository-wide refactor. Lock identifiers
  belong to #1194.
- Adding a real platform still requires a new entity per platform-owned table
  (the verify, welcome, OAuth-state, and OA-token entities currently live in
  the app packages), a migration, repository and module wiring at the
  composition root, and a new lock identifier. The registry removes the
  metadata duplication; it does not make a platform a one-line change.
- `platform: string` sites that are not storage metadata are untouched; that is
  rung 3 of #1217 and builds on this registry.
