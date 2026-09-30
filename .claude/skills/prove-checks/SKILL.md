---
name: prove-checks
description: >-
  Prove a check actually fails before reporting it does. Use before claiming a test
  is meaningful, a mutation goes red, a guard catches a violation, a scan finds
  N items, or a script "ran successfully" — especially after writing a verification
  script, an audit, a migration, or a lint/type rule. Also use when a command's exit
  code is the only evidence you have.
---

# Prove checks

A command that exits 0 having done nothing looks exactly like a passing result.
That ambiguity is the whole hazard: it does not announce itself, and the failure
mode is reporting it as proof.

## The rule

**Never report a result a command did not produce.** Before claiming a check went
red, a scan found N items, or a migration did X — confirm the command *did* the
work. Exit code alone is not that confirmation; it is consistent with "never ran".

Three specific ways this goes wrong, all real:

| Symptom | Cause |
|---|---|
| `-replace` reports 0 replacements, file looks unchanged | Built the pattern with `\n`, file is CRLF |
| `spawnSync('npx', …)` returns `status: null`, `stdout: undefined` | `npx` is a `.cmd` shim on Windows; needs `shell: true` |
| Parse yields 0 rows from a report you can see has rows | Output is ANSI-coloured, or the parser silently matched nothing |

The middle one is the nastiest, because a `try/catch` around the spawn turns it
into a clean empty result. **Never let a spawn failure fall through as empty
output** — throw on `r.error`.

## Mutation

`scripts/verify-mutation.mjs` applies a mutation, runs a command against it, and
restores the file. It refuses a substring that matches anything other than exactly
once, and it prints `CHECK IS REAL` or `CHECK IS FAKE`.

```bash
export MUT_FILE=path/to/file.ts
export MUT_FROM='const exact text to replace'
export MUT_TO='const broken version'
node .claude/skills/prove-checks/scripts/verify-mutation.mjs -- npm run test --workspace=@wispace/pkg
```

Env vars rather than argv so code containing quotes needs no shell escaping. The
tool exits 0 only when the command failed against the broken code, so it is safe
to gate on.

Run it on your own test when:

- a new assertion covers a branch, an error path, or a fail-closed guarantee
- you deleted code and want to know whether any test noticed
- you are about to write "this test is meaningful" in a commit or an issue

If the mutation survives, the assertion is **tautological** — it recomputes the
answer the way the code does, so it passes whether or not the logic is right. Fix
the assertion, not the mutation.

## Scans and audits

Before reporting a scan's count:

1. Confirm the count is plausible against a second source (a `Select-String`, a
   file listing) when the number decides whether work is needed.
2. Make the parser self-checking: if the raw report mentions rows but the parse
   returns none, **exit non-zero**. A parser that matches nothing must never be
   able to report success.
3. Read back from disk after writing. A write that did not land is the same
   failure wearing a different hat.

Self-verifying shape — the part that catches you:

```js
const rawMentions = (out.match(/Unused eslint-disable directive/g) ?? []).length;
if (hits.length === 0 && rawMentions > 0) {
  throw new Error(`parser broken: ${rawMentions} mentioned, 0 parsed`);
}
```

## What needs proving

| Claim | Minimum evidence |
|---|---|
| "this test is meaningful" | mutation → red (`verify-mutation.mjs`) |
| "the guard catches this" | insert one real violation → the command fails |
| "the scan found N" | N > 0 *and* a second source agrees |
| "the migration removed N" | read back from disk; N removed == N expected |
| "it passes" | the command was re-run after the last edit |
| "it was already done" | `git log -S '<the string the issue names>' -- <file>` |

That last row is the one that saves the most work: a `git log -S` on the symbol
an issue names, before writing any code, turns "implement this" into "close this"
in one command. See the `refactor-audit` skill.

## Style

Say what was run and what it printed. If a check could not be run, write that
instead of implying it passed. "Typecheck 45/45, 4582 tests green" is worth
reading; "verified" is not.

## Never

- Report a mutation went red without confirming the mutation applied
- Let a `try/catch` turn a spawn or IO failure into an empty result
- Present a passing exit code as proof the work happened
- Assert something you have not read back from disk
