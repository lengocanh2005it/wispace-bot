---
status: accepted
decided: 2026-09-28
issue: 1143
---

# Clarification state is a pure core with a store-owned compare-and-set memento

Clarification state is decided by a pure core that takes a state and a clock
value and returns a state or a decision, and persisted by a thin responder that
owns the store and keeps the version number internal. The compare-and-set
memento is already present in the store's own `get` and version-gated `set`, so
no snapshot or restore API is added. The decision vocabulary carries lists of
outcomes, because a branch that counts two outcomes is an ordinary branch and
must not need a special case to be expressible.

## Context

#1143 asked to encapsulate clarification state "behind snapshot-restore". That
request was written against an assumption the tree does not support: that a
state machine had to be added. One already exists, in
`packages/chat-agent/src/clarification/clarification-state.ts`, alongside the
state shape and the store interface.

The real problem is that nothing treats the machine as a boundary. Its only
production consumer is `PlatformAgentService`, which reads and mutates the
state's fields directly, derives the expected version by hand for each
version-gated write, and re-derives the machine's own decisions inline where
that is more convenient. Concurrency safety is therefore a convention: a site
that forgets the expected version is a silent lost update, and nothing in the
type system or the build fails.

The store is not the missing piece. `ClarificationStateStore` is already a
compare-and-set: `get(key)`, `set(key, state, expectedVersion?)`, and
`clear(key, expectedVersion?)`. The Redis implementation performs the version
check inside a Lua script, so the read and the gated write are one atomic step.
That is a memento: a snapshot taken before a mutation, and a restore gated on
the version that snapshot carried.

The decision is spread across inline branches, and the outcome it produces is
untyped. The telemetry port is `clarificationOutcomeInc?: (outcome: string) =>
void`, and `BotMetricsService.incClarificationOutcome` increments a counter
declared with `labelNames: ['outcome']` from a `string` parameter. No type in
the system names the set of outcomes, so a branch that forgets to record one,
or records the wrong one, compiles and deploys.

One method on the machine, `getLimits`, has no caller outside its own spec.

This work is triggered by the first half of ADR-0044's rule, not the second:
`platform-agent.service.ts` mixes responsibilities that can be named — free-form
chat orchestration and the clarification lifecycle. There is no duplication
finding, and none is claimed. The file-size baseline entry for that file
currently states the opposite, and the entry's reason is corrected by this
work.

## Outcome

Two layers, not one.

The **core** is pure. It takes a state and a clock value and returns a state or
a decision. It never sees a store, a clock, or a framework. Its public surface
is a short closed list of transitions and queries, so "what can change this
state" is answerable by reading one interface.

The **responder** owns the store. It reads the state, asks the core, writes the
result, and keeps the version number to itself — the version is never part of
anything the responder returns. It maps one decision to one reply through one
table keyed on the closed union, and that table is the single place where an
outcome, the reply text, and the suppressed-or-delivered flag are named
together, so "count it but do not send it" cannot be half-applied. The decision
it applies a rule to is narrowed to a terminal kind and the kind is read *off
that decision*, so a decision and the kind it is answered under are not two
independent arguments. That is a correction this design made after review: a
helper taking both accepted a `{ kind: 'consumed' }` decision under the
`choice` kind, read the choice off a decision that did not carry one, and
silently dropped the accepted choice. The same review found the post-conflict
re-read re-stating the replay rule inline; it now asks the same core inspection,
so the replay rule is stated once.

The persisted shape of a state, both stores, the store interface, the injection
token, the validation on read-back, the time-to-live and attempt bounds, the
outcome labels, and the one-attempt-with-one-bounded-retry compare-and-set
semantics are all unchanged. This is a change to the shape of the code, not to
the bot's behaviour.

## Why no snapshot or restore API

The original issue asked for encapsulation behind snapshot-restore. The
pattern is already there: the store's `get` and its version-gated `set` are
exactly a snapshot taken before a mutation and a restore gated on the version
that snapshot carried. Methods that call those two would be a rename with no
added capability, and a rename added during a refactor is a rename that is
never removed.

That would be a shortcut, not a design, and the reason is specific rather than
stylistic. The atomicity that makes the memento worth having lives in the Lua
script inside the store, not in whatever calls it. A `snapshot()`/`restore()`
pair sitting above `get`/`set` would advertise encapsulation that is not doing
the work, and a wrapper that hid `set`'s third argument would make the version
gate *less* visible than the argument it replaced. The encapsulation that is
real here is the responder keeping the version internal, which is a different
constraint enforced in a different place.

The absence is a decision, so it is recorded. A later reader comparing the code
against #1143 will find two requested methods missing.

## Why the decision carries lists of outcomes

The decision table maps a decision to its outcomes, and the outcome is a list.
Several branches today count two outcomes each: at the commit this record was
written, `blocked_tool` is emitted alongside a branch's own label at four
sites — with `replayed`, with `max_reset`, with `started_offtopic` or
`started_ambiguous`, and with `unavailable`.

A single-value table would still compile. `Record<Decision, string>` is
satisfied by picking one of the two, the omitted label is indistinguishable
from a deliberate choice at the type level, and the counter that receives it is
typed `string`, so nothing downstream notices either. The failure mode is
therefore a miscount that no check reports.

That is the same class of defect that #1035 was: a clarification message
swallowed with no reply, and nothing in the system able to say so. A
single-value column would have made that shape reachable and legal. The list
type is what makes it unrepresentable instead of merely reviewable, so adding
a decision without an outcome, or with a second outcome, is a compile error
rather than a judgement call.

## Why the decision vocabulary is not a contracts type

ADR-0043 puts a type in `@wispace/contracts` when a deciding context, an
applying context, and a recording context all read it. The decision vocabulary
is read by one context: the core decides with it, the reply table in the same
package applies it, and the counter that records the outcome takes a `string`
rather than the union. `packages/contracts` already holds the cross-context
part of this feature — `clarification_state` as a privacy-cleanup store name
and `clearClarification` on the `PrivacyStateCleanup` contract — which is the
correct boundary and is untouched.

The determination is deliberate, so it carries the test that would falsify it.
If a second context ever has to interpret a decision — a platform application
branching on one, or `bot-metrics` taking the union as its parameter type
instead of a `string` — then two contexts read it, it moves to
`@wispace/contracts`, and ADR-0043's `contracts-owned-type-single-declaration`
rule forbids a second declaration of it anywhere else, specs included.

## Alternatives

**A single store-aware machine.** Rejected. It forces the nineteen test cases
now in `packages/chat-agent/src/clarification/` onto a fake store: a large
reviewable-for-nothing cost, paid against tests that assert bounds, expiry,
version increments, and stale-write rejection — none of which need storage. It
is recorded here so it is not re-proposed.

**A single pure machine.** Rejected. The version-gated write would stay
hand-written at every call site, which is the actual defect, so the handler
barely shrinks and the first acceptance criterion is only half met.

**A subpath entrypoint for the new core.** Not taken, and out of scope. This
package still publishes a root barrel, and ADR-0041's `no-root-package-entrypoint`
rule does not cover it — the enforced list does not include this package. The
core therefore stays an internal module under `src/clarification/`, and seven
clarification symbols are dropped from the root barrel because nothing outside
the package imports them, not because an entrypoint rule makes them dead
surface: the deleted state machine class `ClarificationStateMachine`, the state
type `ClarificationState`, the memory store `MemoryClarificationStateStore`, and
the four internal types `ClarificationLimits`, `ClarificationConfigReader`,
`ClarificationIrrelevantResult`, `ClarificationChoice` and
`ClarificationIrrelevantAction`. A word-boundary scan over every `ts`, `mjs` and
`js` file outside the package found zero importers of all seven. The store class
the operational drill constructs by value (`RedisClarificationStateStore`), the
key function, the injection token, the factory and the `ClarificationStateStore`
type all have real importers and stay exported.

## Accounting

Total code is flat to slightly larger. A core, a responder, and a table are
added while roughly 330 lines move out of the agent service, and a duplicate
expiry comparison and a dead method are removed. ADR-0044 records that a split
which moves code out and leaves the total flat costs effort and buys nothing,
and that is correct: this work is not motivated by size, and it is not a
size reduction or a performance change.

The file split is a **consequence** of making the encapsulation enforceable, not
a goal. A field-access prohibition is only real if the code that accessed
fields lives somewhere the type system can constrain, and it cannot be
constrained while it is a method on the same service. ADR-0044's ratchet then
does its ordinary job: the baseline entry's reason is rewritten to name the
responsibility seam this work acts on, and the measurement stamp moves with it.

## Consequences

- A caller cannot read or mutate a clarification field, so the next change
  cannot bypass the decisions without appearing in a diff of a module whose
  subject is those decisions.
- The version-gated write is expressed once. A forgotten expected version is no
  longer expressible outside the responder.
- The outcome set is named by a type, so "every decision has at least one
  outcome" is an assertion rather than an inference from reading branches.
- The total is larger than before. Anyone proposing this shape again for a
  size reason has misread it; the reason is the enforceable boundary.
- The outcome labels are unchanged, so no dashboard, alert or runbook written
  against the *names* needs editing. Two counts are not, and the difference is
  deliberate. The `max_reset` path used to record its two outcomes and only then
  attempt the version-gated clear, so a clear that lost its race fell into the
  fail-closed catch and counted four outcomes
  (`blocked_tool`, `max_reset`, `unavailable`, `blocked_tool`); it now clears
  first, like every other write, and counts two (`unavailable`, `blocked_tool`).
  In the other direction, a write that loses its version gate and re-reads the
  same event already answered used to count `skip_delivery` alone and now also
  counts `replayed` on both write paths. Reply text, skip flag, persisted shape
  and compare-and-set semantics are identical in all three cases; only the
  counters move, and each is the more accurate count. `.claude/rules/chat-rate-limit.md`,
  `apps/messenger-bot/docs/chat-rate-limit-quota.md` and
  `docs/project-overview.md` carry the widened meaning of `replayed`.

## References

- [#1143](https://github.com/lengocanh2005it/wispace-bot/issues/1143) — the design spec this record summarises
- [#1035](https://github.com/lengocanh2005it/wispace-bot/issues/1035) — the swallowed-clarification regression the outcome shape is chosen against
- [ADR-0009 — Chat response postures](0009-chat-response-postures.md) — names clarification as posture 9; it names the prompt core and `isAmbiguousMessage` and constrains no file or import this work touches
- [ADR-0041 — Shared package core and adapter entrypoints](0041-shared-package-entrypoints.md)
- [ADR-0043 — Contract ownership taxonomy](0043-contract-ownership-taxonomy.md)
- [ADR-0044 — Decomposition is driven by duplicated responsibilities, not by file size](0044-decomposition-drivers-not-file-size.md)
- [#778](https://github.com/lengocanh2005it/wispace-bot/issues/778) — owner of the file-size baseline entry this work corrects
