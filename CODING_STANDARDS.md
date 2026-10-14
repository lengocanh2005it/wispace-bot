# Coding standards

Read during **review**, not implementation. Mechanical rules are enforced by the
repo's own guardrails and are listed here only so a reviewer knows to trust them
rather than re-check them by eye:

| Rule                                            | Enforced by                                                                                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Import boundaries, cross-feature edges          | `npm run architecture:check`                                                                                                              |
| Declared-but-unimported runtime deps            | `npm run manifest-deps:check`                                                                                                             |
| Workspace package used without being declared   | `npm run workspace-deps:check`                                                                                                            |
| Declared `exports` subpath nothing imports      | `npm run entrypoint-consumers:check`                                                                                                      |
| Formatting                                      | `npm run format:check`                                                                                                                    |
| Suppressions that suppress nothing              | `oxlint --report-unused-disable-directives-severity=error` — on the root `lint` script that CI runs, and on all 24 workspace lint scripts |
| Raw external IDs in log lines                   | `node .github/scripts/check-log-redaction.js`                                                                                             |
| Platform storage literals in covered consumers  | `bash .github/scripts/check-platform-storage-literals.sh`                                                                                 |
| Token-less reschedule confirm entry paths       | `bash .github/scripts/check-reschedule-confirm-handlers.sh`                                                                               |
| Chat module bypassing the chat provider factory | `bash .github/scripts/check-platform-chat-providers.sh`                                                                                   |
| Tracked file growing past its ceiling           | `npm run file-size:check`                                                                                                                 |

If one of these is red, the review is not finished — fix it, do not argue with it.

The gate's mechanics — how `npm run verify` is composed, where a new check has to
be wired, and what each guard cannot see — are in
[`docs/agent-verify-gate.md`](docs/agent-verify-gate.md). `AGENTS.md` carries the
invariants that hold while writing code; this file carries the judgement a reviewer
makes afterwards.

---

## Reporting a task done

Green checks are not the same as delivered. Each of these has been missed in this
repo while everything was green, so check them explicitly:

- **Pushed** — `git status` clean and the branch on the remote, not only committed
  locally.
- **CI on the current SHA** — `gh pr checks` lists jobs without proving they belong
  to the head. Query `check-runs` for the PR's `headRefOid` and confirm every
  conclusion is `success`.
- **Issue state matches reality** — an issue closed by a `Closes #N` line is closed,
  but a _comment saying what landed_ is still owed. A comment written before the
  work records the plan; only one written after records the outcome.
- **Acceptance criteria actually met** — see _Closing an issue_ below.
- **Labels match state** — a closed issue still carrying `ready-for-agent` gets
  picked up by the next triage pass.
- **Numbers in the issue and PR body are current** — recount after implementation.
  Counts written during design were right about scope and wrong about detail more
  than once.
- **Dependencies are actually bound** — a port token bound in a module that does not
  provide the class consuming it resolves to `undefined`, and an `@Optional()`
  parameter swallows the error. Every check stays green while the dependency is
  simply gone. `docs/architecture-boundaries.md` has the wiring map.

## Closing an issue

**Every checkbox ticked in a closing comment maps to a line in the diff, or to a
named out-of-scope issue.** Both directions of this fail silently, and both have
happened here: issues closed with half their criteria met, and code landed that
left its issue open.

Before closing:

- Re-read the issue's acceptance criteria against the actual diff, not against
  your memory of the work.
- A criterion you satisfied _partially_ stays unticked, or is split into its own
  issue with a link. It does not get softened into prose.
- A criterion that turns out to be **wrong** is called out by name, with what the
  code actually does. Do not quietly implement something adjacent and tick the
  box.
- A criterion that is **blocked** stays unticked, and the blocker is named with
  the issue that owns it.

Then comment with the commit, the evidence per criterion, and what remains. Set
`state_reason` explicitly.

**A protected-surface hash rewrite is a review event, not a formatting pass.** A PR
that changes a protected prompt, agent, evaluator or workflow surface _and_ any
eval fixture hash (`coreHash` or `promptFiles[].hash`) must carry the exact
`eval-rehash-approved` label plus a fresh current-head APPROVED review from a
trusted OWNER or MEMBER who is not the author. Normal behaviour PRs stay
hash-stale and red; after one merges, a hash-only rehash PR is rebased on main
with `Rehashes: #<behavior-pr>` in its body. The policy workflow rechecks the
review and label events and never rewrites fixtures itself.

## Refactors and dead code

- **Verify the premise before writing code.** Audit-pass issues go stale. Use
  `refactor-audit`; the short form is one `git log -S` on the string the issue
  names.
- **Unify only after diffing every copy.** Symmetric call sites can implement two
  different rules. Check what each _compares_ — encoding, casing, target — before
  merging them. Also check which copy is the hardened one; a copy missing a
  fail-closed path is a finding in its own right.
- **A mechanical change gets a deterministic check, not a written rule.** Deleting
  N copies of a pattern, moving files, banned import shapes. Prose goes stale; a
  guard does not.
- **Observe the new guard failing.** Insert one real violation, confirm the
  command fails, revert. Use `prove-checks`.
- **Prefer deletion.** Removing a wrapper, a mirror spec, or a redundant adapter
  beats adding an abstraction over it.

## Claims in code, comments and commits

- **A comment states a reason or a constraint, never a narration.** Not what the
  next line does. A comment that is _deliberately_ redundant with an adjacent guard
  says so, because the next reader will otherwise delete it as dead.
- **A comment that looks dead may be load-bearing.** Check before removing: a
  suppression can be dead by rename rather than by redundancy, and a length check
  above a `try` can be what keeps the `catch` meaningful.
- **A commit message says why.** The diff already says what.
- **Never report a result a command did not produce.** See `prove-checks`. Exit
  code 0 is consistent with "never ran", and reporting it as proof is the failure.

## Commits and pull requests

- Commit and push only when the user asks. Force pushes and git-config edits stay
  off regardless of convenience.
- No `.env` or secret-bearing file enters a commit; the repo carries
  `.env.example` only.
- Review the verify result required by `AGENTS.md` before a PR. CI uses the same
  root gate with affected workspaces on pull requests.

## Consistency

- **Follow the surrounding file, not your preference.** If the file uses one of
  two shapes, match it; a third shape is a review comment.
- **A new abstraction needs two real callers today.** One caller is a function.
- **Prefer the codebase's existing helper over a new one**, including for
  validation and normalisation. A second validator for the same rule is a defect
  even when it is correct.
- **A constant, table or token belongs in the registry that already exists.**
  Check for one first; a second source is how the two drift.
- **A fact that already lives in an ADR, a runbook, a guard script or code is
  referenced, not restated.** `AGENTS.md` is the navigation index; a rule that
  already has a home is linked from there, and two copies of one meaning is a
  defect even when both are correct.
- **Doc parity is part of acceptance.** A behaviour, API, env, runbook, schema or
  closed-gap change has corresponding updates in the relevant `docs/` runbook,
  `.claude/rules/` file and `.env.example`, where applicable.

## Boundaries — actions that wait for an explicit request

Committing, pushing, force pushing, changing git config, closing or commenting on
issues, adding a broker (Bull, SQS, Redis) where the repo uses SQL outbox tables
and advisory locks, and creating markdown outside `docs/` other than the root
`AGENTS.md` / `CODING_STANDARDS.md` / `CLAUDE.md` require an explicit request.
Updates to existing authoritative runbooks and `.claude/rules/` files remain part
of doc parity (see above).

## Language

- User-facing messages: Vietnamese. Logs and code comments: English, or short
  Vietnamese where the logic is not self-evident.
