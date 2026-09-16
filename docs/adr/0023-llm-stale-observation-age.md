# Age-based reduction for stale LLM tool observations

## Status

Accepted (#1236)

## Context

Per-result projection, sanitization, and truncation bound each tool
observation, but an observation can still remain verbatim across later rounds
of the same agent turn. The existing cumulative context trim is a hard-drop
fallback and should not be the first way to make room for newer observations.

## Decision

`ContextManager` tracks loop-generated `role='tool'` messages in a private
`WeakMap` sidecar with their origin tool round and success state. At the start
of each tool round, before the provider request and observation-budget
calculation, observations whose age reaches `staleObservationRounds` are
downgraded to a bounded marker. The default threshold is two rounds and can
be overridden by the shared `OPENAI_STALE_OBSERVATION_ROUNDS` setting; invalid
or non-positive values use the default.

Failed observations are protected until they are three rounds old so a recent
error remains available for an immediate retry. A downgrade replaces only the
sanitized content: the tool message role, `toolCallId`, assistant tool-call
frame, ordering, and provider pairing stay unchanged. The marker contains the
success state, `_observation='truncated'`, `reason='age'`, and the origin round;
it never copies tool names, identifiers, learner text, or raw errors.

Existing per-result reduction, duplicate detection, loop/execution caps,
hard-drop trimming, fallback behavior, metrics, and injection telemetry remain
unchanged. The original reduction is the only injection-sanitization event;
the age marker is generated from constants and is not re-sanitized.

## Consequences

Later rounds receive more context room without changing the provider message
contract or adding storage. Old observations are no longer fresh grounding, so
the agent must use an existing authoritative tool call when a current personal
fact is needed. The age policy is deliberately binary and has no runtime age
metric; before/after token impact is measured offline on the six-round
regression fixture.
