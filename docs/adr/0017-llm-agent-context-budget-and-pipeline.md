# LLM agent context budget and internal pipeline

## Status

Implemented

## Context

The shared agent had an unused event-streaming surface and a semantic history
compaction path that added cache, execution, and safety branches. Context size
was also decided in several places, so tool schemas and loop messages could be
omitted from the same limit.

## Decision

Remove the unused streaming adapter and agent APIs, semantic compaction, and
its cache wiring. Keep the public `LlmAgentService` constructor, `reply()`,
configuration, and provider contracts focused on one synchronous response path.

Use one token budget for the complete provider request: system prompt,
reasoning instructions, serialized tool definitions, sanitized history, user
turn, and loop-generated messages. A valid `maxInputTokens` value wins;
otherwise `maxContextChars * 0.67` is converted once. If the fixed context or
the loop cannot fit, the service fails closed with its normal fallback.

Keep orchestration seams package-private (no root-barrel exports):

- `AgentLimits` normalizes limits and owns the canonical budget.
- `ContextManager` sanitizes history, builds messages, and trims oldest tool
  call groups with a dropped-observation marker while preserving provider
  pairing.
- `ToolRoundExecutor` owns deduplication, read-only parallelism,
  side-effect serialization, cancellation, timeouts, and bounded observations.
- `SafetyPipeline` evaluates raw grounding, then reply sanitization, then the
  final-output guard; telemetry remains in the orchestrator.

Pinned learner facts and environment/boot validation remain separate work.

## Consequences

The public API is smaller and every provider request uses the same bounded
context accounting. The trade-off is a conservative tokenizer-free estimate;
provider-specific tokenizers can replace it only when the package gains a
stable provider-neutral contract for them.
