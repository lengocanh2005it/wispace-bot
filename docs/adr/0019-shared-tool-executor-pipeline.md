# Shared tool-executor pipeline

## Status

Accepted (#762 design)

## Context

The shared Discord/Zalo executor and the Messenger executor duplicate the
tool-execution prologue and dispatch skeleton. That duplication lets identity,
policy, write-budget, abort, or metric behavior drift between platforms; the
Messenger executor also needs platform-specific result decoration such as rich
follow-ups.

## Decision

Use one shared **tool-executor pipeline** for the ordered lifecycle:

1. reject an unknown external tool name;
2. parse and validate arguments;
3. resolve and validate a normalized platform identity when the capability
   requires a linked account;
4. enforce capability policy and explicit intent/confirmation;
5. enforce write-budget gates;
6. invoke an exhaustive platform handler; and
7. run platform result decoration only after a valid handler result.

Each platform supplies an exhaustive `AgentToolName`-keyed handler registry and
platform-owned identity lookup, ports, tokens, and decoration hook. The shared
pipeline owns fail-closed ordering, bounded policy-denied metrics, sanitised
handler-error handling, abort propagation, and write-budget refund lifecycle.
The existing `PlatformToolExecutorPort`, DI tokens, result shapes, and public
composition-root wiring remain stable.

Messenger's `tryFastDefaultReschedule` remains an app-owned fast path outside
the pipeline. Platform handlers do not move into tool specs or the framework-
agnostic `llm-agent` package.

## Conformance

The conformance matrix is generated from the registered tool capability and
metadata. It exercises every production executor for identity,
explicit-intent/confirmation, write-budget, bounded/no-raw-data policy metrics,
and abort behavior, and includes a deliberately incomplete executor that must
fail the conformance check.

## Alternatives considered

- Keep two switches and duplicate prologues: rejected because a new tool can
  silently diverge on one platform.
- Use an abstract base class: rejected in favor of composition so platform DI
  and ports remain app-owned and the shared package stays framework-agnostic.
- Put `execute()` on each tool spec: rejected; tool specs declare shared facts,
  while platform handlers own execution and dependencies.

## Scope

- **#762**: shared prologue/pipeline, exhaustive platform handler registries,
  Messenger result-decoration hook, executor conformance, and behavior parity.
- **#1216**: declarative registry, typed projections, metadata-on-spec, and
  exhaustive checks for the existing dispatch boundary.
- **Out of scope**: new tools, prompt changes, platform-port relocation,
  dynamic plugins, and tool-schema/token reduction.
