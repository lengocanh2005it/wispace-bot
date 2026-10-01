# Coding standards

Read during **review**, not implementation. Mechanical rules are enforced by the
repo's own guardrails and are listed here only so a reviewer knows to trust them
rather than re-check them by eye:

| Rule | Enforced by |
|---|---|
| Import boundaries, cross-feature edges | `npm run architecture:check` |
| Declared-but-unimported runtime deps | `npm run manifest-deps:check` |
| Workspace package used without being declared | `npm run workspace-deps:check` |
| Declared `exports` subpath nothing imports | `npm run entrypoint-consumers:check` |
| Formatting | `npm run format:check` |
| Suppressions that suppress nothing | `oxlint --report-unused-disable-directives-severity=error` — on the root `lint` script that CI runs, and on all 24 workspace lint scripts |
| Raw external IDs in log lines | `node .github/scripts/check-log-redaction.js` |
| Platform storage literals in covered consumers | `bash .github/scripts/check-platform-storage-literals.sh` |
| Token-less reschedule confirm entry paths | `bash .github/scripts/check-reschedule-confirm-handlers.sh` |
| Tracked file growing past its ceiling | `npm run file-size:check` |

If one of these is red, the review is not finished — fix it, do not argue with it.

---

## Judgement calls

These no guardrail can check. They are the reviewer's job.

### Closing an issue

**Every checkbox ticked in a closing comment maps to a line in the diff, or to a
named out-of-scope issue.** Both directions of this fail silently, and both have
happened here: issues closed with half their criteria met, and code landed that
left its issue open.

Before closing:

- Re-read the issue's acceptance criteria against the actual diff, not against
  your memory of the work.
- A criterion you satisfied *partially* stays unticked, or is split into its own
  issue with a link. It does not get softened into prose.
- A criterion that turns out to be **wrong** is called out by name, with what the
  code actually does. Do not quietly implement something adjacent and tick the
  box.
- A criterion that is **blocked** stays unticked, and the blocker is named with
  the issue that owns it.

Then comment with the commit, the evidence per criterion, and what remains. Set
`state_reason` explicitly. A comment written before the work records the plan; a
comment written after records the outcome — only the second one is a report.

### Refactors and dead code

- **Verify the premise before writing code.** Audit-pass issues go stale. Use
  `refactor-audit`; the short form is one `git log -S` on the string the issue
  names.
- **Unify only after diffing every copy.** Symmetric call sites can implement two
  different rules. Check what each *compares* — encoding, casing, target — before
  merging them. Also check which copy is the hardened one; a copy missing a
  fail-closed path is a finding in its own right.
- **A mechanical change gets a deterministic check, not a written rule.** Deleting
  N copies of a pattern, moving files, banned import shapes. Prose goes stale; a
  guard does not.
- **Observe the new guard failing.** Insert one real violation, confirm the
  command fails, revert. Use `prove-checks`.
- **Prefer deletion.** Removing a wrapper, a mirror spec, or a redundant adapter
  beats adding an abstraction over it.

### Claims in code, comments and commits

- **A comment states a reason or a constraint, never a narration.** Not what the
  next line does. A comment that is *deliberately* redundant with an adjacent guard
  says so, because the next reader will otherwise delete it as dead.
- **A comment that looks dead may be load-bearing.** Check before removing: a
  suppression can be dead by rename rather than by redundancy, and a length check
  above a `try` can be what keeps the `catch` meaningful.
- **A commit message says why.** The diff already says what.
- **Never report a result a command did not produce.** See `prove-checks`. Exit
  code 0 is consistent with "never ran", and reporting it as proof is the failure.

### Consistency

- **Follow the surrounding file, not your preference.** If the file uses one of
  two shapes, match it; a third shape is a review comment.
- **A new abstraction needs two real callers today.** One caller is a function.
- **Prefer the codebase's existing helper over a new one**, including for
  validation and normalisation. A second validator for the same rule is a defect
  even when it is correct.
- **A constant, table or token belongs in the registry that already exists.**
  Check for one first; a second source is how the two drift.

### Language

- User-facing messages: Vietnamese. Logs and code comments: English, or short
  Vietnamese where the logic is not self-evident.
- `AGENTS.md` is the navigation index. If a rule here duplicates a line there,
  the rule belongs in one place — not both.
