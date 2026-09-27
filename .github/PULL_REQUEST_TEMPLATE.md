## Context (#NNN)

<!-- Why this PR exists. Reference the issue(s) and describe the problem —
     what breaks today, severity, and the evidence (file/line) where useful.
     Group tightly-coupled issues into one PR and justify the grouping. -->

## Change

<!-- What changed, per area/file. Keep it concrete: new modules, key logic,
     migrations, config, docs. -->

## Tests

<!-- How it is verified: new/updated specs (name the files), test commands,
     CI gate results (turbo lint typecheck test build), manual checks. -->

## Behaviour surface

<!-- Required when this PR moves code between modules or files. A decomposition
     must not change any of these; they are the surfaces no test would catch a
     change to, which is why they are written down rather than left to "no
     behavior change" (ADR-0044, #1433):

     - the package's public exports and entrypoint surface
     - dependency-injection tokens, and the arity and order of the constructor
       parameters a composition root supplies
     - the rows, columns, and transaction boundaries a repository writes
     - Redis key names and stored value shapes
     - metric and span names emitted
     - learner-facing message text
     - the derivation of idempotency keys

     If this PR changes one of them deliberately, it needs its own decision and
     issue. Do not use this section to record an accidental one. -->
Not applicable — no code moved between modules or files

## Spec edits

<!-- Required only when this PR edits a `*.spec.ts`. State which of the two it
     was, because they are not the same kind of change (ADR-0044):
     - Structure — the spec asserted a module path, a private member, or a call
       order that is not observable from outside, and now follows the code.
     - Behavior — a spec asserting a public contract is not weakened to
       accommodate a move. If a contract genuinely has to change, that needs its
       own decision, not a justification here.

     Then state the reason it was structure rather than behavior, in terms a
     reviewer can check against the rule above. Restating the change is not a
     reason. -->
Not applicable

## Issues

<!-- One line per issue, e.g. `Closes #123` — this auto-closes them on merge. -->

Closes #NNN
