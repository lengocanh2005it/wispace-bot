# ADR-0045: The eval harness prompt-hash path has one implementation

Status: Accepted
Date: 2026-09-04

## Context

`packages/llm-agent/src/eval/` contains the offline orchestration regression
harness (`eval-harness.ts`) and the fixture rehash tool (`rehash-fixtures.ts`).
Both need to read a prompt file, normalize its line endings, and compute a
sha256. They each implemented that sequence independently.

The duplication did not stay benign. Two copies of the same escape check
disagree:

| Site | Check |
| --- | --- |
| `eval-harness.ts` `loadPrompt` | `relativePath.startsWith('..') \|\| relativePath.startsWith('.')` |
| `rehash-fixtures.ts` `isRepoPath` | `relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath)` |

The `isRepoPath` form is correct on Windows. `path.relative()` between two
different drive letters returns an absolute path, which does not start with
`..`, so the harness form **accepts** a prompt path on another drive. The same
form also **rejects** dotfiles inside the repo, because `.gitattributes`
starts with `.`. Both behaviours were verified against `path.relative` on
this platform.

Root cause of the duplication: `loadPrompt` resolves its path through
`resolvePromptPath`, which takes an injectable `repoRoot`, but then compares
against the module-level `REPO_ROOT` and ignores the injection. A caller
cannot ask it to hash against an alternate root, so `rehash-fixtures.ts` wrote
its own.

Two further copies of the same normalization exist: `runEvalFixture` inlines
`CHAT_SYSTEM_PROMPT_CORE.replace(/\r\n/g, '\n')` instead of calling the
exported `normalizePromptContent`, and `rehash-fixtures.ts` re-implements
`errorMessage` as `errorText`.

Fixture-directory discovery is written a third and fourth time in
`rehash-fixtures.ts`, `guardrail-battery.ts`, and `privacy-guard.spec.ts`.

The harness is a protected surface under
[ADR-0020](./0020-locked-evaluator-rehash-boundary.md), and
[ADR-0044](./0044-decomposition-drivers-not-file-size.md) requires a
decomposition to be argued from a named responsibility seam or duplicated
implementation. The duplication above is such a seam.

## Decision

Extract the prompt-file read path into one module, `eval-prompt-hash.ts`, and
make both `eval-harness.ts` and `rehash-fixtures.ts` consume it.

- The module owns `sha256Hex`, `normalizePromptContent`, `resolvePromptPath`,
  the escape check, and a single `readPromptHash(repoRoot, path)`.
- The escape check is the `isRepoPath` form, because it is the one that is
  correct on Windows. Fixing the harness form here is a deliberate behavior
  change: paths outside the repo and dotfiles inside it are now both handled
  correctly.
- `loadPrompt` gains an injectable `repoRoot` and delegates to
  `readPromptHash`, so the two callers cannot diverge again.
- `runEvalFixture` calls `normalizePromptContent` instead of inlining the
  regex.
- The repo root is resolved on first use and memoized, via `getRepoRoot()`.
  It used to be a module-level const, so merely importing an eval module walked
  the filesystem and threw when no `turbo.json` was reachable — a consumer or
  a build could fail before it did any work. Failure now happens at the call
  that needs a path, not at import. A spec locks this down by re-importing the
  module with a counting `existsSync` and asserting zero probes at load; it
  observes 5 probes when the module-level const is reintroduced.
- The package jest config gains a `moduleNameMapper` that strips a trailing
  `.js` from relative specifiers. The package compiles with
  `module: nodenext`, so a dynamic `import()` must name the `.js` extension
  while jest resolves against `moduleFileExtensions`. No existing import ends
  in `.js`, so the mapping is inert for the rest of the suite.
- `rehash-fixtures.ts` uses the shared `errorMessage` from
  `@wispace/bot-common/masking` instead of its local `errorText`.
- Fixture-directory discovery moves to one shared `listFixtures` helper.

We deliberately do **not** add `eval/index.ts`. Barrels in this package exist
only to back a published subpath in the `exports` map
([ADR-0041](./0041-shared-package-entrypoints.md)); `eval/` is not published,
so a barrel would be a departure from the convention with no consumer to
serve.

We deliberately do **not** treat the size of `eval-harness.ts` as the driver.
It is 1307 lines and remains large after this change. That is acceptable under
ADR-0044, which makes line count evidence, never a gate.

## Consequences

- The Windows cross-drive escape hole in `loadPrompt` is closed, and the
  dotfile false positive is removed.
- A future change to line-ending normalization or to the escape check now
  applies to the harness, the rehash tool, the guardrail battery, and the
  privacy guard together, because they share one implementation.
- `rehash-fixtures.ts` no longer duplicates the read path, which is the
  widest coupling edge into `eval-harness.ts` and lets that module be split
  later without touching the rehash tool.
- The behavior change to the escape check means a fixture pinned to a
  dotfile prompt path, or one reaching outside the repo, changes outcome. No
  current fixture does; the 124-fixture suite is the check.
