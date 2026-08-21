# Observability Implementation Plan (#290, #302)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Discord/Zalo chat metrics into Prometheus and add core SLO alerts.

**Architecture:** `createMetricsModule(prefix, tracerName)` already exists in `@wispace/bot-metrics` — both bots already import it. The only gap is that `PlatformAgentService` factories in Discord/Zalo don't inject `BotMetricsService` or pass it as `metrics`. Fix: inject + adapter mapping (same pattern as Messenger). Then add threshold-based SLO alerts to `alert.rules.yml`.

**Tech Stack:** TypeORM, NestJS, Prometheus, Jest.

## Global Constraints

- Match Messenger's adapter pattern exactly: `metrics.timeLlmCall`, `metrics.timeTool`, `metrics.incRoundOutcome`.
- `BotMetricsService` is already globally available via `createMetricsModule`.
- Alerts use threshold-based approach (p95 latency, error rate, availability).
- No changes to `BotMetricsService` itself.

---

### Task 1: Wire metrics into Discord PlatformAgentService

**Files:**
- Modify: `apps/discord-bot/src/modules/discord-chat/discord-chat.module.ts`

**Interfaces:**
- Consumes: `BotMetricsService` (globally provided by `createMetricsModule('discord', 'discord-bot')`)
- Produces: `PlatformAgentService` now receives `metrics` option

- [ ] **Step 1: Add BotMetricsService import**

In `discord-chat.module.ts`, add to the existing `@wispace/bot-metrics` import:

```typescript
import {
  PlatformLlmSafetyEventAdapter,
  PlatformLlmUsageRecorderAdapter,
  BotMetricsService,
} from '@wispace/chat-metering';
```

Wait — let me check what's already imported. Actually, `BotMetricsService` comes from `@wispace/bot-metrics`, not `@wispace/chat-metering`. Let me check the current imports.

- [ ] **Step 2: Inject BotMetricsService into PlatformAgentService factory**

Add `BotMetricsService` to the factory inject array and wire the adapter:

```typescript
{
  provide: PlatformAgentService,
  useFactory: (
    configService: ConfigService,
    toolsService: PlatformAgentToolsService,
    historyService: PlatformChatHistoryService,
    usageRecorder: PlatformLlmUsageRecorderAdapter,
    safetyEventService: PlatformLlmSafetyEventAdapter,
    adapter: LlmProviderAdapter,
    learnerProfileStore: LearnerProfileStorePort,
    metrics: BotMetricsService,
  ) => {
    const learnerProfileSuffix = createLearnerProfileSuffix(
      learnerProfileStore,
      'discord',
    );
    return new PlatformAgentService(
      configService,
      toolsService,
      historyService,
      usageRecorder,
      safetyEventService,
      adapter,
      {
        promptDir: join(__dirname, '../../shared/prompts'),
        promptFile: 'discord-chat.system.txt',
        maxLlmRetries: 0,
        toolExecutionTimeoutMs: 35_000,
        systemPromptSuffix: learnerProfileSuffix,
        onToolResult: createLearnerProfileRecorder(
          learnerProfileStore,
          'discord',
        ),
        metrics: {
          timeLlmCall: (feature, model, round, fn) =>
            metrics.timeLlmCall(feature, model, round, fn),
          timeTool: (toolName, fn) => metrics.timeTool(toolName, fn),
          llmRoundOutcomeInc: (feature, outcome) =>
            metrics.incRoundOutcome(feature, outcome),
        },
      },
    );
  },
  inject: [
    ConfigService,
    PlatformAgentToolsService,
    PlatformChatHistoryService,
    PlatformLlmUsageRecorderAdapter,
    PlatformLlmSafetyEventAdapter,
    'LLM_PROVIDER_ADAPTER',
    LEARNER_PROFILE_STORE,
    BotMetricsService,
  ],
},
```

- [ ] **Step 3: Commit**

```bash
git add apps/discord-bot/src/modules/discord-chat/discord-chat.module.ts
git commit -m "feat(discord): wire BotMetricsService into PlatformAgentService (#290)"
```

---

### Task 2: Wire metrics into Zalo PlatformAgentService

**Files:**
- Modify: `apps/zalo-bot/src/modules/zalo-chat/zalo-chat.module.ts`

**Interfaces:**
- Consumes: `BotMetricsService` (globally provided by `createMetricsModule('zalo', 'zalo-bot')`)
- Produces: `PlatformAgentService` now receives `metrics` option

- [ ] **Step 1: Inject BotMetricsService into PlatformAgentService factory**

Same pattern as Discord — add `BotMetricsService` to inject array, wire adapter in options.

- [ ] **Step 2: Commit**

```bash
git add apps/zalo-bot/src/modules/zalo-chat/zalo-chat.module.ts
git commit -m "feat(zalo): wire BotMetricsService into PlatformAgentService (#290)"
```

---

### Task 3: Add SLO alert rules

**Files:**
- Modify: `deploy/monitoring/alert.rules.yml`

**Interfaces:**
- Produces: Prometheus alert rules for chat availability, LLM latency, LLM error rate.

- [ ] **Step 1: Add alert rules**

Append to `deploy/monitoring/alert.rules.yml`:

```yaml
      - alert: ChatAvailabilityLow
        expr: |
          (
            1 - (
              sum(rate(chat_step_duration_seconds{status="error"}[5m])) by (job)
              /
              sum(rate(chat_step_duration_seconds[5m])) by (job)
            )
          ) < 0.99
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: '{{ $labels.job }} chat availability below 99%'

      - alert: LlmLatencyHigh
        expr: |
          histogram_quantile(0.95,
            sum(rate(llm_call_duration_seconds_bucket[5m])) by (job, le)
          ) > 30
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: '{{ $labels.job }} LLM p95 latency above 30s'

      - alert: LlmErrorRateHigh
        expr: |
          (
            sum(rate(llm_round_outcome_total{outcome="error"}[5m])) by (job)
            /
            sum(rate(llm_round_outcome_total[5m])) by (job)
          ) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: '{{ $labels.job }} LLM error rate above 5%'
```

- [ ] **Step 2: Commit**

```bash
git add deploy/monitoring/alert.rules.yml
git commit -m "feat(monitoring): add per-bot SLO alerts for availability, latency, error rate (#302)"
```
