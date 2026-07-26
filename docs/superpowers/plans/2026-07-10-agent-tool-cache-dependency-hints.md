# Agent Tool Result Cache + Dependency Hints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add TTL-based in-memory tool result cache to `LlmAgentService` and update tool descriptions with dependency hints.

**Architecture:** `ToolResultCachePort` interface (optional) is injected into `LlmAgentPorts`. `InMemoryToolResultCache` is a plain Map-based implementation in the package. Agent loop checks cache before executing a tool, sets after success, invalidates `list_study_calendar_entries` after `reschedule_study_session` succeeds.

**Tech Stack:** TypeScript, plain Map (no external deps), Jest

## Global Constraints

- `packages/llm-agent` does not import NestJS or TypeORM — uses built-in JS only
- Cache is optional — if `toolResultCache` is not injected, the agent works as before
- Error results (`{ ok: false }`) are not cached
- Cache invalidation is scoped by `externalUserId`
- Run tests: `npx turbo run test --filter=@wispace/llm-agent`
- Run full verify: `npx turbo run lint build test --filter=@wispace/messenger-bot... --filter=@wispace/llm-agent`

---

### Task 1: ToolResultCachePort + InMemoryToolResultCache

**Files:**
- Create: `packages/llm-agent/src/tool-cache/tool-result-cache.port.ts`
- Create: `packages/llm-agent/src/tool-cache/in-memory-tool-result-cache.ts`
- Create: `packages/llm-agent/src/tool-cache/in-memory-tool-result-cache.spec.ts`

**Interfaces:**
- Produces:
  - `ToolResultCachePort` interface with `get(key: string): unknown | undefined`, `set(key: string, value: unknown, ttlMs: number): void`, `invalidate(key: string): void`, `invalidatePrefix(prefix: string): void`
  - `InMemoryToolResultCache` class implementing `ToolResultCachePort`
  - `NOOP_TOOL_RESULT_CACHE: ToolResultCachePort` (no-op for when not injected)

- [ ] **Step 1: Write failing tests**

Create file `packages/llm-agent/src/tool-cache/in-memory-tool-result-cache.spec.ts`:

```ts
import { InMemoryToolResultCache } from './in-memory-tool-result-cache';

describe('InMemoryToolResultCache', () => {
  it('returns undefined for cache miss', () => {
    const cache = new InMemoryToolResultCache();
    expect(cache.get('missing-key')).toBeUndefined();
  });

  it('returns value after set', () => {
    const cache = new InMemoryToolResultCache();
    cache.set('key', { data: 'test' }, 60_000);
    expect(cache.get('key')).toEqual({ data: 'test' });
  });

  it('returns undefined after TTL expires', () => {
    const cache = new InMemoryToolResultCache();
    cache.set('key', { data: 'test' }, -1); // already expired
    expect(cache.get('key')).toBeUndefined();
  });

  it('invalidate removes specific key', () => {
    const cache = new InMemoryToolResultCache();
    cache.set('key-a', 'a', 60_000);
    cache.set('key-b', 'b', 60_000);
    cache.invalidate('key-a');
    expect(cache.get('key-a')).toBeUndefined();
    expect(cache.get('key-b')).toBe('b');
  });

  it('invalidatePrefix removes all keys starting with prefix', () => {
    const cache = new InMemoryToolResultCache();
    cache.set('user123:list_study_calendar_entries:abc', 'x', 60_000);
    cache.set('user123:list_study_calendar_entries:def', 'y', 60_000);
    cache.set('user123:get_user_goals:ghi', 'z', 60_000);
    cache.invalidatePrefix('user123:list_study_calendar_entries:');
    expect(cache.get('user123:list_study_calendar_entries:abc')).toBeUndefined();
    expect(cache.get('user123:list_study_calendar_entries:def')).toBeUndefined();
    expect(cache.get('user123:get_user_goals:ghi')).toBe('z');
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
npx turbo run test --filter=@wispace/llm-agent
```

Expected: FAIL — `Cannot find module './in-memory-tool-result-cache'`

- [ ] **Step 3: Create port interface**

Create `packages/llm-agent/src/tool-cache/tool-result-cache.port.ts`:

```ts
export interface ToolResultCachePort {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown, ttlMs: number): void;
  invalidate(key: string): void;
  /** Removes all keys whose string starts with the given prefix. */
  invalidatePrefix(prefix: string): void;
}

export const NOOP_TOOL_RESULT_CACHE: ToolResultCachePort = {
  get: () => undefined,
  set: () => undefined,
  invalidate: () => undefined,
  invalidatePrefix: () => undefined,
};
```

- [ ] **Step 4: Implement InMemoryToolResultCache**

Create `packages/llm-agent/src/tool-cache/in-memory-tool-result-cache.ts`:

```ts
import type { ToolResultCachePort } from './tool-result-cache.port';

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

export class InMemoryToolResultCache implements ToolResultCachePort {
  private readonly store = new Map<string, CacheEntry>();

  get(key: string): unknown | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: unknown, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  invalidatePrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }
}
```

- [ ] **Step 5: Run test to confirm it passes**

```bash
npx turbo run test --filter=@wispace/llm-agent
```

Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent/src/tool-cache/
git commit -m "feat(llm-agent): add ToolResultCachePort + InMemoryToolResultCache"
```

---

### Task 2: Wire cache into LlmAgentConfig, LlmAgentPorts, agent.service.ts

**Files:**
- Modify: `packages/llm-agent/src/types.ts`
- Modify: `packages/llm-agent/src/agent.service.ts`
- Modify: `packages/llm-agent/src/agent.service.spec.ts`

**Interfaces:**
- Consumes:
  - `ToolResultCachePort` from `./tool-cache/tool-result-cache.port`
  - `NOOP_TOOL_RESULT_CACHE` from `./tool-cache/tool-result-cache.port`
- Produces:
  - `LlmAgentConfig.toolCacheTtlMs?: number`
  - `LlmAgentPorts.toolResultCache?: ToolResultCachePort`
  - Cache key format: `${externalUserId}:${toolName}:${stableHash(argsJson)}`
  - Invalidation after `reschedule_study_session` succeeds

- [ ] **Step 1: Add `toolCacheTtlMs` to `LlmAgentConfig`**

Modify `packages/llm-agent/src/types.ts`:

```ts
export interface LlmAgentConfig {
  /** @deprecated Use adapter.isConfigured() instead. Kept for backward compat. */
  apiKey?: string;
  model?: string;
  maxToolRounds?: number;
  maxContextChars?: number;
  /** TTL for tool result cache in ms. Default: 300_000 (5 min). 0 = disable cache. */
  toolCacheTtlMs?: number;
}
```

- [ ] **Step 2: Add `toolResultCache` to `LlmAgentPorts` in `agent.service.ts`**

Add import at the top of `packages/llm-agent/src/agent.service.ts`:

```ts
import type { ToolResultCachePort } from './tool-cache/tool-result-cache.port';
import { NOOP_TOOL_RESULT_CACHE } from './tool-cache/tool-result-cache.port';
```

Modify the `LlmAgentPorts` interface in the same file:

```ts
export interface LlmAgentPorts<TToolContext> {
  llmExecution: LlmExecutionPort;
  usageRecorder: LlmUsageRecorderPort;
  safetyEvents: LlmSafetyEventPort;
  toolExecutor: ToolExecutorPort<TToolContext>;
  adapter: LlmProviderAdapter;
  toolResultCache?: ToolResultCachePort;
  metrics?: AgentMetricsPort;
  logger?: {
    warn: (message: string) => void;
    debug: (message: string) => void;
  };
}
```

- [ ] **Step 3: Add `stableHash` helper to `agent.service.ts`**

Add the following function after the `const` declarations at the top of the file (after `NOOP_LOGGER`):

```ts
/** djb2 hash of the argsJson string — sufficient for distinguishing different tool args. */
function stableHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash >>> 0; // convert to unsigned 32-bit
  }
  return hash.toString(36);
}

const DEFAULT_TOOL_CACHE_TTL_MS = 300_000; // 5 minutes
const RESCHEDULE_TOOL = 'reschedule_study_session';
const CALENDAR_TOOL = 'list_study_calendar_entries';
```

- [ ] **Step 4: Add cache logic to the tool execution block in `reply()`**

In the `reply()` method, find the line `const toolResults = await Promise.all(` and replace that entire block:

```ts
      const cache = this.ports.toolResultCache ?? NOOP_TOOL_RESULT_CACHE;
      const cacheTtlMs = this.getToolCacheTtlMs();

      // Execute all tool calls in this round in parallel
      const toolResults = await Promise.all(
        toolCalls.map(async (toolCall) => {
          const toolName = toolCall.name;
          toolsCalledThisTurn.add(toolName);
          const argsJson = toolCall.arguments || '{}';
          const cacheKey = `${input.externalUserId}:${toolName}:${stableHash(argsJson)}`;

          let content: string;
          try {
            // Cache lookup
            const cached = cacheTtlMs > 0 ? cache.get(cacheKey) : undefined;
            let result: unknown;
            if (cached !== undefined) {
              logger.debug(
                `Tool cache hit externalUserId=${input.externalUserId} tool=${toolName}`,
              );
              result = cached;
            } else {
              result = await metrics.timeTool(toolName, () =>
                this.ports.toolExecutor.execute(toolName, argsJson, toolContext),
              );
              // Cache successful result; invalidate calendar after reschedule
              if (cacheTtlMs > 0) {
                cache.set(cacheKey, result, cacheTtlMs);
                if (toolName === RESCHEDULE_TOOL) {
                  cache.invalidatePrefix(
                    `${input.externalUserId}:${CALENDAR_TOOL}:`,
                  );
                  logger.debug(
                    `Cache invalidated ${CALENDAR_TOOL} for externalUserId=${input.externalUserId} after reschedule`,
                  );
                }
              }
            }
            const raw = JSON.stringify({ ok: true, data: result });
            const sanitized = sanitizeToolResultContent(raw);
            if (sanitized.wasSanitized) {
              logger.warn(
                `Tool result sanitized externalUserId=${input.externalUserId} tool=${toolName} reason=${sanitized.reason}`,
              );
            }
            content = sanitized.content;
          } catch (err) {
            const message =
              err instanceof Error ? err.message : 'unknown error';
            logger.warn(
              `Tool execution failed externalUserId=${input.externalUserId} tool=${toolName} error=${message}`,
            );
            content = JSON.stringify({ ok: false, error: message });
          }

          return { toolCallId: toolCall.id, content };
        }),
      );
```

- [ ] **Step 5: Add `getToolCacheTtlMs()` private method to the class**

Add after `getMaxToolRounds()`:

```ts
  private getToolCacheTtlMs(): number {
    const v = this.config.toolCacheTtlMs;
    if (v === 0) return 0; // explicit disable
    if (v && Number.isFinite(v) && v > 0) return Math.floor(v);
    return DEFAULT_TOOL_CACHE_TTL_MS;
  }
```

- [ ] **Step 6: Write tests for cache behavior**

Add to the end of `packages/llm-agent/src/agent.service.spec.ts`:

```ts
  describe('reply() — tool result cache', () => {
    function buildServiceWithCache(
      overrides: {
        execute?: jest.Mock;
        adapter?: LlmProviderAdapter;
        toolCacheTtlMs?: number;
      } = {},
    ) {
      const usageRecorder = { recordFromCompletion: jest.fn() };
      const safetyEvents = { recordGroundingWarning: jest.fn() };
      const llmExecution = {
        run: jest.fn().mockImplementation((_fn: () => Promise<unknown>) => _fn()),
      };
      const toolExecutor = {
        execute: overrides.execute ?? jest.fn().mockResolvedValue({ ok: true }),
      };
      const toolResultCache = {
        get: jest.fn().mockReturnValue(undefined),
        set: jest.fn(),
        invalidate: jest.fn(),
        invalidatePrefix: jest.fn(),
      };

      const ports: LlmAgentPorts<StubToolContext> = {
        llmExecution,
        usageRecorder,
        safetyEvents,
        toolExecutor,
        adapter: overrides.adapter ?? makeAdapter([makeTextResponse('stub')]),
        metrics: NOOP_METRICS_PORT,
        logger: { warn: jest.fn(), debug: jest.fn() },
        toolResultCache,
      };

      const service = new LlmAgentService<StubToolContext>(
        { toolCacheTtlMs: overrides.toolCacheTtlMs ?? 60_000 },
        ports,
      );

      return { service, toolExecutor, toolResultCache };
    }

    it('skips execute on cache hit and reuses cached result', async () => {
      const cachedData = { goals: 'cached' };
      const toolResponse = makeToolCallResponse('get_user_goals');
      const textResponse = makeTextResponse('Kết quả từ cache.');
      const adapter = makeAdapter([toolResponse, textResponse]);
      const execute = jest.fn();

      const { service, toolResultCache } = buildServiceWithCache({ adapter, execute });
      toolResultCache.get.mockReturnValue(cachedData);

      await service.reply(BASE_INPUT, TOOL_CONTEXT);

      expect(execute).not.toHaveBeenCalled();
    });

    it('calls execute on cache miss and stores result', async () => {
      const toolResponse = makeToolCallResponse('get_user_goals');
      const textResponse = makeTextResponse('Kết quả.');
      const adapter = makeAdapter([toolResponse, textResponse]);
      const execute = jest.fn().mockResolvedValue({ goals: [] });

      const { service, toolResultCache } = buildServiceWithCache({ adapter, execute });
      toolResultCache.get.mockReturnValue(undefined);

      await service.reply(BASE_INPUT, TOOL_CONTEXT);

      expect(execute).toHaveBeenCalledTimes(1);
      expect(toolResultCache.set).toHaveBeenCalledWith(
        expect.stringContaining('get_user_goals'),
        { goals: [] },
        60_000,
      );
    });

    it('invalidates list_study_calendar_entries after reschedule_study_session', async () => {
      const toolResponse = makeToolCallResponse('reschedule_study_session', '{"calendarId":1,"schedulingMode":"default_next_day_same_time"}');
      const textResponse = makeTextResponse('Đã đổi lịch.');
      const adapter = makeAdapter([toolResponse, textResponse]);
      const execute = jest.fn().mockResolvedValue({ success: true });

      const { service, toolResultCache } = buildServiceWithCache({ adapter, execute });
      toolResultCache.get.mockReturnValue(undefined);

      await service.reply(BASE_INPUT, TOOL_CONTEXT);

      expect(toolResultCache.invalidatePrefix).toHaveBeenCalledWith(
        `${BASE_INPUT.externalUserId}:list_study_calendar_entries:`,
      );
    });

    it('does not cache error results', async () => {
      const toolResponse = makeToolCallResponse('get_user_goals');
      const textResponse = makeTextResponse('Lỗi.');
      const adapter = makeAdapter([toolResponse, textResponse]);
      const execute = jest.fn().mockRejectedValue(new Error('timeout'));

      const { service, toolResultCache } = buildServiceWithCache({ adapter, execute });
      toolResultCache.get.mockReturnValue(undefined);

      await service.reply(BASE_INPUT, TOOL_CONTEXT);

      expect(toolResultCache.set).not.toHaveBeenCalled();
    });

    it('skips cache entirely when toolCacheTtlMs is 0', async () => {
      const toolResponse = makeToolCallResponse('get_user_goals');
      const textResponse = makeTextResponse('Kết quả.');
      const adapter = makeAdapter([toolResponse, textResponse]);
      const execute = jest.fn().mockResolvedValue({ goals: [] });

      const { service, toolResultCache } = buildServiceWithCache({
        adapter,
        execute,
        toolCacheTtlMs: 0,
      });

      await service.reply(BASE_INPUT, TOOL_CONTEXT);

      expect(toolResultCache.get).not.toHaveBeenCalled();
      expect(toolResultCache.set).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });
```

- [ ] **Step 7: Run tests**

```bash
npx turbo run test --filter=@wispace/llm-agent
```

Expected: all tests PASS

- [ ] **Step 8: Commit**

```bash
git add packages/llm-agent/src/types.ts packages/llm-agent/src/agent.service.ts packages/llm-agent/src/agent.service.spec.ts
git commit -m "feat(llm-agent): wire tool result cache into agent loop"
```

---

### Task 3: Export cache types from index.ts

**Files:**
- Modify: `packages/llm-agent/src/index.ts`

**Interfaces:**
- Consumes: `ToolResultCachePort`, `NOOP_TOOL_RESULT_CACHE`, `InMemoryToolResultCache` from Task 1
- Produces: public API of the package exports the above types

- [ ] **Step 1: Add exports to `packages/llm-agent/src/index.ts`**

Add at the end of the file (after the `// --- Provider abstraction (new) ---` block):

```ts
// --- Tool result cache ---
export type { ToolResultCachePort } from './tool-cache/tool-result-cache.port';
export { NOOP_TOOL_RESULT_CACHE } from './tool-cache/tool-result-cache.port';
export { InMemoryToolResultCache } from './tool-cache/in-memory-tool-result-cache';
```

- [ ] **Step 2: Build to verify exports compile**

```bash
npx turbo run build --filter=@wispace/llm-agent
```

Expected: build succeeds, no type errors

- [ ] **Step 3: Commit**

```bash
git add packages/llm-agent/src/index.ts
git commit -m "feat(llm-agent): export ToolResultCachePort and InMemoryToolResultCache"
```

---

### Task 4: Tool dependency hints (C1)

**Files:**
- Modify: `packages/llm-agent/src/agent.tools.ts`

**Interfaces:**
- No interface changes — only update the `description` string of 2 tools

- [ ] **Step 1: Update description of `reschedule_study_session`**

In `packages/llm-agent/src/agent.tools.ts`, find the tool `reschedule_study_session` and modify its `description`:

```ts
  {
    name: 'reschedule_study_session',
    description:
      'Always call `list_study_calendar_entries` first to get the `calendarId`. Then prepare to reschedule the study session (send a confirmation button to the student; only execute after the student clicks Confirm). default_next_day_same_time = same time, +1 day from the session being rescheduled (tomorrow\'s session → day after tomorrow). explicit when the student specifies a new date/time.',
```

- [ ] **Step 2: Update description of `get_upcoming_study_sessions`**

Find the tool `get_upcoming_study_sessions` and modify its `description`:

```ts
  {
    name: 'get_upcoming_study_sessions',
    description:
      'List upcoming IELTS Writing study sessions from the student\'s UserCalendar schedule. Use to display the schedule. If a calendarId is needed for rescheduling, use list_study_calendar_entries instead.',
```

- [ ] **Step 3: Run full verify**

```bash
npx turbo run lint build test --filter=@wispace/messenger-bot... --filter=@wispace/llm-agent
```

Expected: all tasks PASS

- [ ] **Step 4: Commit**

```bash
git add packages/llm-agent/src/agent.tools.ts
git commit -m "feat(llm-agent): add dependency hints to tool descriptions (C1)"
```

---

## Self-Review

**Spec coverage:**
- ✅ `ToolResultCachePort` interface with `get/set/invalidate/invalidatePrefix` — Task 1
- ✅ `InMemoryToolResultCache` Map-based implementation — Task 1
- ✅ `NOOP_TOOL_RESULT_CACHE` no-op — Task 1
- ✅ Cache key format `${externalUserId}:${toolName}:${stableHash(argsJson)}` — Task 2
- ✅ `toolCacheTtlMs` configurable, default 5 min — Task 2
- ✅ Cache check before execute, set after success — Task 2
- ✅ Error results not cached — Task 2 + test
- ✅ Invalidate `list_study_calendar_entries` after `reschedule_study_session` — Task 2
- ✅ Cache optional (agent works without it) — `NOOP_TOOL_RESULT_CACHE` fallback
- ✅ Export public API — Task 3
- ✅ Dependency hints `reschedule_study_session` + `get_upcoming_study_sessions` — Task 4
- ✅ Full final verify — Task 4 Step 3
