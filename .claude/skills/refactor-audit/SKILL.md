---
name: refactor-audit
description: >-
  Triage a refactor/architecture issue before implementing it. Use when picking up a
  refactor, architecture, code-quality or tech-debt issue, when asked "what refactor
  issues are left", or when a list of issues is proposed as a roadmap. Verifies the
  issue premise against the code first, since many are already fixed or premise-wrong.
---

# Refactor audit

Refactor issues rot in both directions: closed without the code landing, and code
landed without the issue closing. Both were live in this repo at once. The cheapest
work in a refactor programme is often an issue you can close without writing code.

## Order

**1 — Read the issue body, not the title.** The title states a symptom. The body
usually carries the evidence, and that evidence is what you check.

**2 — Verify the premise before writing any code.** Issues here are written by
audit passes and go stale. Check the claim in the code, not against the title.

```bash
# "this is already fixed" — the single highest-value command in this skill
git log -1 --format="%h %ad %s" --date=short -S "<the exact string the issue names>" -- <the file it names>
```

Then read the current state of the named lines. Look for the *specific* claim:
the cast, the duplicated block, the extra branch, the missing rule.

**3 — Classify what you actually found.** Four outcomes, and only the last two
need code:

| Finding | Action |
|---|---|
| Already fixed | Close it, cite the commit, name what to do instead |
| Premise wrong | Close or rewrite, and say which part was wrong |
| Real but needs a design decision | Leave open, record the decision needed, do not guess it |
| Real and small | Implement it |

**4 — Never close an issue whose acceptance criteria are not met.** If only part
landed, say exactly which part, and open or link the issue that owns the rest. A
checklist that silently loses a box is worse than an open issue: it reports
progress that does not exist.

## The three ways the premise check fails

**Symmetric forms are not the same rule.** Three call sites sharing a shape may
implement two different rules. Read what each one *compares* before unifying —
encoding, casing, and comparison target all matter. A shared helper that is
*nearly* right hides the difference rather than removing it.

**A "duplicate" is not always a defect.** Sometimes it is dead code; sometimes one
copy is the hardened one and the others are not. Diff them before deciding which
direction to unify in, and check whether a copy is missing a fail-closed path
today.

**Check the rule name too.** A suppression can be dead by *rename* rather than by
redundancy — the config spells a rule differently than the comment names it. Those
stay dead even after the underlying rule is enabled.

## When you do write the code

Mechanical change → deterministic check, not a written rule. Deleting N copies of
a pattern, moving files, or a banned import shape all belong in the repo's linter
or a pre-commit hook. Reserve a prose rule for a judgement call — cross-file
consistency, "matches the surrounding style", anything no guardrail substitutes
for.

Then **prove the guard bites**: insert one real violation, confirm the command
fails, revert. A guard never observed failing is a guess. Use `prove-checks`.

## Surveying the backlog

Filter labels undercount. This repo's shape, measured:

```
issues with label `refactor`                        73
all open issues                                     769
```

Six issues in an architecture roadmap carried no `refactor` label at all. Query
**unfiltered**, then filter client-side — and say which you did. A count stated
without its filter is not a fact.

Rank by what a *reading* costs, not by what writing costs. Measuring an issue
costs a grep and can retire it; implementing one costs a diff and a CI cycle.
That asymmetry is the argument for auditing before building.

## Close the loop

Comment with: the commit, the evidence for each acceptance criterion, and — when
the premise was wrong — what the code actually does. Then set `state_reason`
explicitly. A comment recording the plan is not a record of the outcome.
