# Declarative agent-tool registry

## Status

Accepted (#1216)

## Context

Adding one agent tool currently requires edits across the tool list, tool spec,
observation allowlist, learner-facing labels, grounding sets, write-budget
sets, and more. Several of those structures are keyed by `string`, so a missed
entry compiles and degrades only on a later runtime path.

There are also two platform dispatch switches. The dispatch/prologue
unification is owned by #762; this decision covers the shared registry and its
metadata boundary without moving platform execution into `llm-agent`.

The repository already treats one zod schema plus capability metadata as the
canonical declaration for each tool (ADR-0010). The remaining policy maps
should use that same declaration rather than becoming another registry.

## Decision

Use the tool-spec list as the single source of truth for registered agent
tools.

- Derive `AgentToolName` and the runtime `AGENT_TOOL_NAMES` list from the
  specs; do not maintain a parallel name list.
- Type every tool-keyed map and set by `AgentToolName`.
- Keep the runtime `isAgentToolName` guard at the provider boundary. Once a
  name passes the guard, internal dispatch receives `AgentToolName` and uses a
  `never` exhaustiveness check instead of casting to `string`.
- Add required declarative metadata to every spec:
  - observation fields;
  - learner-facing label;
  - grounding claim families (possibly empty);
  - budget classification: `none`, `write`, or `exempt`;
  - write-action label when the classification is `write`.
- Derive observation, label, grounding, and write-budget projections from the
  specs. Keep numeric caps and environment-specific budget settings in
  `chat-metering`.
- Keep platform handlers and dependency injection in the applications and
  platform adapters. The registry does not gain `execute()` in this change.
- Preserve existing map exports and behavior while changing their
  implementation to derived projections.

The runtime registry validator must validate the new metadata as well as the
existing capability metadata. A checked-in TypeScript fixture must prove that
an incomplete registry produces a compile error; the fixture uses the
existing compiler/tooling and adds no type-test dependency.

## Implementation order

1. Make the specs the source of truth and derive names.
2. Type the existing projections and replace the internal dispatch casts with
   exhaustive checks.
3. Add required metadata and derive the existing projections from it.
4. Add the negative compile-time fixture and preserve behavior tests for all
   existing tools.

Dispatch-switch consolidation and the platform hook remain #762's scope.

## Alternatives considered

| Alternative                                            | Reason for rejection                                                                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Keep a hand-maintained name list and string-keyed maps | Missed wiring remains a silent runtime degradation.                                                                    |
| Put numeric caps and config keys on the shared specs   | Couples the framework-agnostic registry to metering configuration.                                                     |
| Move `execute()` into each spec                        | Pulls platform ports and dependency injection into the shared registry; the benefit does not justify the new boundary. |
| Rely only on TypeScript                                | Built JavaScript and runtime-loaded data still need fail-closed validation.                                            |

## Consequences

- Adding a tool becomes a compiler-guided change; omissions in typed
  projections or exhaustive dispatch fail before runtime.
- Shared policy metadata has one declarative owner and existing consumers can
  keep their public map APIs.
- The first phase still requires multiple edits; the one-or-two-place claim is
  only valid after metadata projections are consolidated.
- Numeric budget configuration remains separate, so a tool's classification
  and its deployment-specific cap are intentionally different concerns.

## Scope

- **#1216**: registry source of truth, typed projections, exhaustive dispatch
  checks, metadata-on-spec, runtime validation, and compile-time regression
  fixture.
- **#762**: shared dispatch/prologue extraction and platform hook/conformance.
- **Out of scope**: moving platform execution into the spec, prompt-budget
  work, and tool-schema token reduction.
