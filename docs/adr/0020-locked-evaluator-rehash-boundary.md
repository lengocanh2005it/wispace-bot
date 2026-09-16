# Keep evaluator hash rewrites separate from behavior changes

## Status

Accepted (#1238)

## Context

The eval fixtures store hashes of the prompt text used by the offline
guardrail harness. A pull request could previously change a prompt or the
evaluator and rewrite those hashes in the same diff, making the check
self-scoring.

## Decision

The protected prompt, agent, evaluator, and guardrail workflow surface is
classified from the pull request diff. When a protected file and a fixture
hash change appear together, the separate `eval-rehash-policy` workflow fails
unless the pull request has the exact `eval-rehash-approved` label and a fresh
current-head APPROVED review from a trusted OWNER or MEMBER who is not the
author. The existing battery remains read-only and still runs normally.

The normal workflow is intentionally red-then-green: merge the reviewed
behavior change with stale hashes, then rebase main and submit a hash-only
rehash pull request with `Rehashes: #<behavior-pr>` in its body. Review and
label events rerun the policy without rebuilding the battery.
The policy workflow checks out the pull request for diff inspection but runs
the checker source from the base revision. A bootstrap run whose base predates
the checker removes the GitHub token before using the pull request copy and
therefore fails closed whenever metadata is needed.

## Consequences

Hash changes cannot silently redefine the behavior baseline. A short-lived
stale-hash window is visible and requires a deliberate follow-up, while an
exception still has an auditable human approval trail. GitHub branch
protection and CODEOWNERS remain responsible for the final merge controls.
