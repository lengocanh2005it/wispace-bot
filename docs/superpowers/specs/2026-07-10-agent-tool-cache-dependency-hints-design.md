# Agent Tool Result Cache + Tool Dependency Hints

**Date:** 2026-07-10
**Scope:** `packages/llm-agent` only — framework-agnostic, no app-layer changes

> **Current status (2026-08-14):** The generic per-turn tool result cache (TTL `tool-cache`) was **not** implemented. Instead, the hot path is covered by Messenger's per-day student-report cache (`StudentReportService`, key `psid:YYYY-MM-DD`, 5k entries, pre-warmed by the 08:00 cron — the `get_learning_progress_report` tool reuses it, miss → static report, no LLM). Dependency hints between `list_study_calendar_entries` and `reschedule_study_session` are enforced in the reschedule confirm service (calendarId must exist in the upcoming list) rather than via schema-level dependency metadata.

## Problem

1. **Cross-turn tool redundancy** — Each conversation turn, the agent re-fetches data from tools even though the user has not changed anything (goals, study schedule). Causes unnecessary latency and wastes API calls.
2. **Tool ordering errors** — LLM sometimes calls `reschedule_study_session` without a `calendarId` (which must be obtained from `list_study_calendar_entries` first). The tool schema provides no way for the LLM to know about this dependency.

## Solution

### A3 — Tool Result Cache (TTL-based in-memory)

**Port interface** (`tool-cache/tool-result-cache.port.ts`):
```ts
export interface ToolResultCachePort {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown, ttlMs: number): void;
  invalidate(key: string): void;
}
```

**Cache key format:** `${externalUserId}:${toolName}:${stableHash(argsJson)}`
- `stableHash` = djb2 hash of sorted JSON string (no external dependency)
- Distinguishes `get_upcoming_study_sessions(limit=5)` from `limit=10`

**Default implementation** (`tool-cache/in-memory-tool-result-cache.ts`):
- Plain `Map<string, { value: unknown; expiresAt: number }>`
- Lazy eviction on `get()` — no setInterval needed
- Default TTL: 5 minutes (`300_000` ms), configurable via `LlmAgentConfig.toolCacheTtlMs`

**Agent loop integration** (`agent.service.ts`):
```
tool call received
→ build cache key
→ cache.get(key) hit? → use cached, push tool message, skip execute
→ miss → execute() → on success: cache.set(key, result, ttlMs)
         → on error: no cache (always retry errors)
→ special: after reschedule_study_session succeeds → invalidate list_study_calendar_entries keys for this user
```

**Cache is optional:** `LlmAgentPorts.toolResultCache?: ToolResultCachePort` — if not injected, agent works as before, no existing code breaks.

**Config addition** (`types.ts`):
```ts
interface LlmAgentConfig {
  // ...existing...
  toolCacheTtlMs?: number; // default 300_000 (5 min)
}
```

### C1 — Tool Dependency Hints in Descriptions

Modify `agent.tools.ts` — only 2 tool descriptions:

**`reschedule_study_session`:**
> Prepend to description: *"Always call `list_study_calendar_entries` first to obtain `calendarId`."*

**`get_upcoming_study_sessions`:**
> Append to description: *"Used to display schedule. If `calendarId` is needed to reschedule, use `list_study_calendar_entries` instead."*

## Files Changed

| File | Change |
|------|--------|
| `packages/llm-agent/src/tool-cache/tool-result-cache.port.ts` | New — port interface + noop implementation |
| `packages/llm-agent/src/tool-cache/in-memory-tool-result-cache.ts` | New — Map-based implementation |
| `packages/llm-agent/src/agent.service.ts` | Add `toolResultCache?: ToolResultCachePort` to `LlmAgentPorts` |
| `packages/llm-agent/src/types.ts` | Add `toolCacheTtlMs?: number` to `LlmAgentConfig` |
| `packages/llm-agent/src/agent.service.ts` | Cache lookup/set/invalidate in tool execution block |
| `packages/llm-agent/src/agent.tools.ts` | 2 description updates |
| `packages/llm-agent/src/index.ts` | Export new cache types |
| `packages/llm-agent/src/agent.service.spec.ts` | Tests for cache hit/miss/invalidation |

## Constraints

- `packages/llm-agent` does not import NestJS — cache implementation is a plain class
- Cache invalidation is scoped by `externalUserId` — not shared across users
- Error responses (`{ ok: false }`) are not cached
- `reschedule_study_session` is the only tool that triggers invalidation (because it mutates calendar data)

## Testing

- Cache hit: tool is not called a second time for same user + same args
- Cache miss: tool is called when TTL expired
- Invalidation: after `reschedule_study_session`, `list_study_calendar_entries` is evicted
- No-cache path: agent works normally when `toolResultCache` is not injected
- Error not cached: tool error → next call still executes
