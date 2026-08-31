# Per-User Write-Tool Budget (#626) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-user, per-day budget plus a per-message cap for the two mutating LLM tools (`reschedule_study_session`, `precreate_next_exercise`), enforced in the tool executor before the WISPACE call, shared across Messenger + Discord + Zalo.

**Architecture:** A new framework-agnostic daily counter (`chat_tool_daily_usage` table + `WriteToolBudgetCore` in `packages/chat-metering`) is the persistent enforcement point, consumed through a narrow `WriteToolBudgetPort` by the shared `PlatformAgentToolsService` (Discord/Zalo) and the app-owned `MessengerAgentToolsService`. `precreate_next_exercise` is check-and-consumed in the executor with refund on non-success. `reschedule_study_session` is only read-gated in the executor (it merely stages a confirmation); the authoritative daily consume happens at confirm time in the shared `packages/reschedule-confirm` service. The per-message cap is an in-memory per-turn counter on the tool context. A new low-cardinality metric `*_write_tool_budget_denied_total{tool,platform,reason}` records denials.

**Tech Stack:** NestJS 11 · TypeScript (isolatedModules, `import type`) · TypeORM + PostgreSQL (`ai_chat_bot_db`) · Turborepo npm workspaces · Jest · prom-client · oxlint/oxfmt

## Global Constraints

- User-facing strings: **Vietnamese**. Logs/comments: English or short Vietnamese.
- No new runtime dependency, no Redis/Bull — the daily counter is PostgreSQL only.
- `packages/llm-agent` stays framework-agnostic (no NestJS/TypeORM imports). `packages/reschedule-confirm` must not gain a `@wispace/llm-agent` dependency — pass its denial message string in via options.
- Framework-agnostic packages take a constructor config object; NestJS adapter layer reads `ConfigService` and passes plain objects down. Application layer injects ports with `@Inject(TOKEN)` + `import type`.
- Config via `.env` + `ConfigService`; every new knob gets a conservative default and a `.env.example` stub in all three apps.
- Metric labels carry **no user ids** (masked-ids-only rule). Denial metric labels: `tool`, `platform`, `reason` where `reason ∈ {'daily','per_message'}`.
- Do **not** add a duplicate chat-metering entity under `apps/*/infrastructure/database/entities/` — the entity lives in `packages/chat-metering`; only migrations (run by messenger-bot) touch the schema.
- Migration naming: new cross-platform table → domain name, **no** platform prefix. Never rename existing migration classes.
- Default caps (generous — normal use never hits them): `reschedule` 8/day + 1/message; `precreate` 15/day + 3/message.
- Vietnamese denial copy (parameterised, one source of truth in `packages/llm-agent/src/messages.ts`):
  - daily: `Bạn đã dùng hết số lần {action} trong hôm nay rồi. Bạn thử lại vào ngày mai nhé.`
  - per-message: `Trong một tin nhắn mình chỉ xử lý được tối đa {n} lần {action} thôi. Bạn nhắn lại phần còn lại giúp mình nhé.`
  - `{action}`: `reschedule_study_session` → `đổi lịch học`; `precreate_next_exercise` → `tạo bài tập mới`.
- Env var names (all under the existing `CHAT_*` family):
  - `CHAT_WRITE_TOOL_BUDGET_ENABLED` (default `true`; fail-open kill-switch — only `false`/`0`/`no` disables)
  - `CHAT_WRITE_TOOL_DAILY_CAP_RESCHEDULE` (default `8`)
  - `CHAT_WRITE_TOOL_DAILY_CAP_PRECREATE` (default `15`)
  - `CHAT_WRITE_TOOL_PER_MESSAGE_CAP_RESCHEDULE` (default `1`)
  - `CHAT_WRITE_TOOL_PER_MESSAGE_CAP_PRECREATE` (default `3`)
  - reuses `CHAT_USAGE_TIMEZONE` (default `Asia/Ho_Chi_Minh`) and `CHAT_RATE_LIMIT_WHITELIST_PSIDS` (comma list; whitelisted external ids bypass the budget)
  - `CHAT_TOOL_DAILY_USAGE_RETENTION_DAYS` (default `7`) for the cleanup prune

## Design decisions already settled (do not re-litigate)

| # | Decision |
|---|---|
| Q1 | Explicit write-tool allowlist + `BUDGET_EXEMPT_TOOLS` set + a guard test asserting every non-`read_only` agent tool is classified into one or the other. |
| Q2 | Calendar day in `Asia/Ho_Chi_Minh` via `todayUsageDate(tz)`; counter row keyed by date. |
| Q3 | `precreate`: consume before the WISPACE call, refund unless `status === 'created'`. `reschedule`: consume at confirm time, refund if `rescheduleSession` throws. Malformed calls that never reach WISPACE cost nothing. |
| Q4 | Metric `write_tool_budget_denied_total{tool,platform,reason}`. |
| Q5 | Defaults as in Global Constraints. |
| Q8 | `reschedule` = read-only daily check in the executor (advisory), authoritative consume in `packages/reschedule-confirm` confirm handler. `precreate` = check+consume in the executor. |
| Q9 | New table `chat_tool_daily_usage`, unique `(platform, user_id, usage_date, tool_name)`, atomic `INSERT … ON CONFLICT DO UPDATE SET count = count + 1 WHERE count < $cap RETURNING count`. |
| Q10 | `WriteToolBudgetCore` in `packages/chat-metering`; `WriteToolBudgetPort` interface in `packages/chat-agent`; both tool services call it; each app wires a thin adapter. |
| Q11 | Per-message cap = in-memory `Map<string, number>` on `PlatformAgentToolContext`, incremented in the executor, never persisted. |
| Q12 | No per-tool-call idempotency keys — retried batches never re-enter the agent loop (`ChatPipeline` reserve gate returns `false` first); the atomic `WHERE count < cap` increment + existing per-round `(tool,args)` dedupe are sufficient. |
| Q13 | New dedicated metric (not a reused `reason` on `llm_tool_policy_denied_total`). |
| Q14 | Reuse `CHAT_RATE_LIMIT_WHITELIST_PSIDS`; add `CHAT_WRITE_TOOL_BUDGET_ENABLED` kill-switch. |
| Q17 | Executor returns `{ status: 'budget_exceeded', messageHint: <VN> }` (not `{ error }`) so the model relays it as a normal limit. |
| Q18 | Piggyback the existing chat idempotency-cleanup cron: prune `chat_tool_daily_usage` rows older than `CHAT_TOOL_DAILY_USAGE_RETENTION_DAYS` days. |
| Q19 | Executor stage-gate for reschedule is best-effort (reads the confirmed count); confirm-time atomic consume is the hard stop, and over-cap at confirm returns the VN daily message on the confirm/postback path. |

---

## File Structure

**`packages/chat-metering/`** (owns the daily counter)
- Create `src/entities/chat-tool-daily-usage.entity.ts` — TypeORM entity for `chat_tool_daily_usage`.
- Modify `src/entities/index.ts` — export the new entity.
- Modify `src/index.ts` — export entity + `WriteToolBudgetCore` + `WriteToolBudgetRepository` + `PlatformWriteToolBudgetService` + config reader + types.
- Create `src/write-tool-budget/write-tool-budget.types.ts` — `WriteToolBudgetSettings`, `WriteToolBudgetRepositoryPort`, `WriteToolBudgetDeniedReason`.
- Create `src/write-tool-budget/write-tool-budget.repository.ts` — `WriteToolBudgetRepository` (atomic consume / refund / read).
- Create `src/write-tool-budget/write-tool-budget-core.service.ts` — `WriteToolBudgetCore` (enable flag, whitelist, timezone, metric callback).
- Create `src/write-tool-budget/write-tool-budget-config.ts` — `readWriteToolBudgetConfig(get)`.
- Create `src/write-tool-budget/platform-write-tool-budget.service.ts` — `PlatformWriteToolBudgetService` (NestJS adapter, mirrors `PlatformChatRateLimitService`).
- Modify `src/chat-metering.module.ts` — register entity + provide/export `PlatformWriteToolBudgetService`.
- Tests: `src/write-tool-budget/write-tool-budget.repository.spec.ts`, `write-tool-budget-core.service.spec.ts`, `write-tool-budget-config.spec.ts`.

**`packages/database/`** (owns migrations)
- Create `src/migrations/<ts>-CreateChatToolDailyUsageTable.ts` + `.spec.ts`.
- Modify `src/typeorm-options.ts` — add `ChatToolDailyUsageEntity` to the entity list if entities are enumerated there (check; `chat-metering` entities are already listed).

**`packages/llm-agent/`** (owns shared VN copy)
- Modify `src/messages.ts` — `buildWriteToolDailyBudgetMessage(toolName)` + `buildWriteToolPerMessageBudgetMessage(toolName, limit)` + `WRITE_TOOL_ACTION_LABELS`.
- Test: `src/messages.spec.ts` (create if absent) or extend existing message spec.

**`packages/bot-metrics/`** (owns metrics)
- Modify `src/bot-metrics.service.ts` — `writeToolBudgetDenied` counter + `incWriteToolBudgetDenied(tool, platform, reason)`.
- Test: `src/bot-metrics.service.spec.ts` (extend).

**`packages/chat-agent/`** (owns the shared executor + port)
- Create `src/agent/write-tool-budget.ts` — `WRITE_TOOL_NAMES`, `isWriteToolName`, `BUDGET_EXEMPT_TOOLS`, `WriteToolBudgetPort` interface.
- Modify `src/agent/platform-agent.types.ts` — add `writeToolCalls` / `writeToolDailyConsumed` to `PlatformAgentToolContext`; add `writeToolBudget` / `writeToolPerMessageCaps` / `writeToolBudgetDeniedInc` to `PlatformAgentToolsOptions`.
- Modify `src/agent/platform-agent-tools.service.ts` — enforce budget between identity resolution and `dispatch()`; refund precreate on non-success.
- Modify `src/index.ts` — export the new symbols.
- Tests: `src/agent/write-tool-budget.spec.ts` (guard test), extend `src/agent/platform-agent-tools.service.spec.ts`.

**`packages/reschedule-confirm/`** (owns confirm-time consume)
- Modify `src/reschedule-confirm.service.ts` — `RescheduleConfirmationOptions` gains `consumeRescheduleBudget` / `refundRescheduleBudget` / `rescheduleBudgetExceededMessage`; `confirm()` consumes before `rescheduleSession`, refunds on throw.
- Test: extend `src/reschedule-confirm.service.spec.ts` (or the existing spec file — check name).

**`apps/messenger-bot/`**
- Modify `src/modules/messenger/application/agent/messenger-agent-tools.service.ts` — same enforcement as the shared executor (mirror), refund precreate on non-success.
- Modify `src/modules/messenger/application/agent/*` — add `MESSENGER_WRITE_TOOL_BUDGET` + `MESSENGER_WRITE_TOOL_PER_MESSAGE_CAPS` + `MESSENGER_WRITE_TOOL_BUDGET_DENIED_INC` injection symbols.
- Modify `src/modules/chat-rate-limit/chat-rate-limit.module.ts` — register `ChatToolDailyUsageEntity` + provide `PlatformWriteToolBudgetService` (platform `'messenger'`).
- Modify `src/modules/messenger/chat-pipeline.module.ts` — wire the budget service + per-message caps into `MessengerAgentToolsService` and the reschedule-confirm options of `MessengerRescheduleConfirmationService`.
- Modify `src/modules/chat-rate-limit/application/services/chat-idempotency-cleanup-cron.service.ts` — add the `chat_tool_daily_usage` prune.
- Modify `.env.example`.

**`apps/discord-bot/` + `apps/zalo-bot/`**
- Modify `src/modules/*-chat/*-chat.module.ts` — pass `writeToolBudget` (from `PlatformWriteToolBudgetService` via `ChatMeteringModule`), `writeToolPerMessageCaps`, `writeToolBudgetDeniedInc` into `PlatformAgentToolsOptions`; wire `consumeRescheduleBudget`/`refundRescheduleBudget`/`rescheduleBudgetExceededMessage` into the `RescheduleConfirmationService` options.
- Modify `.env.example` (both).

**`packages/cleanup-cron/`**
- Modify `src/platform-cleanup-cron.service.ts` — `handleIdempotencyCleanup` also prunes `chat_tool_daily_usage` (Discord + Zalo).

**Docs**
- Modify `docs/edge-cases-roadmap.md` — mark #626, add a row.
- Modify `docs/project-overview.md` — runbook paragraph (how to tune caps, what the metric means).

---

## Task 1: `chat_tool_daily_usage` table — entity + migration

**Files:**
- Create: `packages/chat-metering/src/entities/chat-tool-daily-usage.entity.ts`
- Modify: `packages/chat-metering/src/entities/index.ts`
- Modify: `packages/chat-metering/src/index.ts:1-6` (the `from './entities'` re-export block)
- Create: `packages/database/src/migrations/1786938000000-CreateChatToolDailyUsageTable.ts`
- Test: `packages/database/src/migrations/1786938000000-CreateChatToolDailyUsageTable.spec.ts`
- Check: `packages/database/src/typeorm-options.ts` — if it enumerates chat-metering entities, add `ChatToolDailyUsageEntity`; if it globs, no change.

**Interfaces:**
- Produces: `ChatToolDailyUsageEntity` with columns `id: number` (PK generated), `platform: string`, `externalUserId: string`, `userId: number`, `usageDate: string`, `toolName: string`, `count: number`, `createdAt: Date`, `updatedAt: Date`; unique index `uq_chat_tool_daily_usage` on `(platform, userId, usageDate, toolName)`.
- Produces: DB table `chat_tool_daily_usage` (same columns, snake_case).

- [ ] **Step 1: Write the entity**

`packages/chat-metering/src/entities/chat-tool-daily-usage.entity.ts`:

```ts
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { Platform } from '@wispace/contracts';

/**
 * Per-user, per-day counter for mutating LLM tool calls (#626). One row per
 * (platform, WISPACE user, calendar day in CHAT_USAGE_TIMEZONE, tool). The
 * unique index backs the atomic `INSERT … ON CONFLICT DO UPDATE … WHERE
 * count < cap` reserve. `external_user_id` is stored non-indexed for ops
 * debugging only — the budget is keyed on `user_id`.
 */
@Entity('chat_tool_daily_usage')
@Index(
  'uq_chat_tool_daily_usage',
  ['platform', 'userId', 'usageDate', 'toolName'],
  { unique: true },
)
export class ChatToolDailyUsageEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 16, default: 'messenger' })
  platform: Platform;

  @Column({ name: 'external_user_id', type: 'varchar', length: 64 })
  externalUserId: string;

  @Column({ name: 'user_id', type: 'int' })
  userId: number;

  @Column({ name: 'usage_date', type: 'date' })
  usageDate: string;

  @Column({ name: 'tool_name', type: 'varchar', length: 64 })
  toolName: string;

  @Column({ type: 'int', default: 0 })
  count: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
```

- [ ] **Step 2: Export the entity**

`packages/chat-metering/src/entities/index.ts` — add:

```ts
export { ChatToolDailyUsageEntity } from './chat-tool-daily-usage.entity';
```

`packages/chat-metering/src/index.ts` — extend the first export block:

```ts
export {
  ChatDailyUsageEntity,
  ChatIdempotencyEntity,
  ChatToolDailyUsageEntity,
  LlmUsageEventEntity,
  LlmSafetyEventEntity,
} from './entities';
```

- [ ] **Step 3: Write the failing migration spec**

`packages/database/src/migrations/1786938000000-CreateChatToolDailyUsageTable.spec.ts`:

```ts
import type { QueryRunner } from 'typeorm';
import { CreateChatToolDailyUsageTable1786938000000 } from './1786938000000-CreateChatToolDailyUsageTable';

describe('CreateChatToolDailyUsageTable1786938000000', () => {
  function makeRunner(): { runner: QueryRunner; queries: string[] } {
    const queries: string[] = [];
    const runner = {
      query: async (sql: string) => {
        queries.push(sql);
        return [];
      },
    } as unknown as QueryRunner;
    return { runner, queries };
  }

  it('up creates the table and the unique index', async () => {
    const { runner, queries } = makeRunner();
    await new CreateChatToolDailyUsageTable1786938000000().up(runner);
    const joined = queries.join('\n');
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS "chat_tool_daily_usage"');
    expect(joined).toContain('"tool_name" varchar(64) NOT NULL');
    expect(joined).toContain('"count" int NOT NULL DEFAULT 0');
    expect(joined).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "uq_chat_tool_daily_usage"',
    );
    expect(joined).toContain(
      '("platform", "user_id", "usage_date", "tool_name")',
    );
  });

  it('down drops the table', async () => {
    const { runner, queries } = makeRunner();
    await new CreateChatToolDailyUsageTable1786938000000().down(runner);
    expect(queries.join('\n')).toContain(
      'DROP TABLE IF EXISTS "chat_tool_daily_usage"',
    );
  });
});
```

- [ ] **Step 4: Run the spec, verify it fails**

Run: `npx turbo run test --filter=@wispace/database -- -t CreateChatToolDailyUsageTable`
Expected: FAIL — module `./1786938000000-CreateChatToolDailyUsageTable` not found.

- [ ] **Step 5: Write the migration**

`packages/database/src/migrations/1786938000000-CreateChatToolDailyUsageTable.ts`:

```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-user write-tool budget (#626): daily counter for mutating LLM tool
 * calls (`reschedule_study_session`, `precreate_next_exercise`). Keyed on
 * the resolved WISPACE `user_id`; `external_user_id` kept for ops debugging.
 */
export class CreateChatToolDailyUsageTable1786938000000
  implements MigrationInterface
{
  name = 'CreateChatToolDailyUsageTable1786938000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "chat_tool_daily_usage" (
        "id" SERIAL PRIMARY KEY,
        "platform" varchar(16) NOT NULL DEFAULT 'messenger',
        "external_user_id" varchar(64) NOT NULL,
        "user_id" int NOT NULL,
        "usage_date" date NOT NULL,
        "tool_name" varchar(64) NOT NULL,
        "count" int NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_chat_tool_daily_usage"
      ON "chat_tool_daily_usage" ("platform", "user_id", "usage_date", "tool_name")
    `);
    await queryRunner.query(`
      COMMENT ON TABLE "chat_tool_daily_usage" IS
        'Per-user per-day mutating-tool call budget (#626)'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_chat_tool_daily_usage"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "chat_tool_daily_usage"`,
    );
  }
}
```

- [ ] **Step 6: Run the spec, verify it passes**

Run: `npx turbo run test --filter=@wispace/database -- -t CreateChatToolDailyUsageTable`
Expected: PASS.

- [ ] **Step 7: Wire the migration into the data source**

Open `packages/database/src/migration-data-source.ts` (and `packages/database/src/typeorm-options.ts`). If migrations are listed explicitly, append `CreateChatToolDailyUsageTable1786938000000`. If they glob (`migrations/*.js`), no change. Do the same check for the entity list — add `ChatToolDailyUsageEntity` wherever `ChatIdempotencyEntity` appears in an explicit array.

- [ ] **Step 8: Typecheck + build both packages**

Run: `npx turbo run typecheck build --filter=@wispace/chat-metering --filter=@wispace/database`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/chat-metering/src/entities packages/chat-metering/src/index.ts packages/database/src/migrations packages/database/src/migration-data-source.ts packages/database/src/typeorm-options.ts
git commit -m "feat(chat-metering): chat_tool_daily_usage table for write-tool budget (#626)"
```

---

## Task 2: `WriteToolBudgetRepository` — atomic consume / refund / read

**Files:**
- Create: `packages/chat-metering/src/write-tool-budget/write-tool-budget.types.ts`
- Create: `packages/chat-metering/src/write-tool-budget/write-tool-budget.repository.ts`
- Test: `packages/chat-metering/src/write-tool-budget/write-tool-budget.repository.spec.ts`

**Interfaces:**
- Consumes: `Repository<ChatToolDailyUsageEntity>` from Task 1, `Platform` from `@wispace/contracts`.
- Produces:
  ```ts
  export type WriteToolBudgetDeniedReason = 'daily' | 'per_message';

  export interface WriteToolBudgetRepositoryPort {
    getDailyCount(userId: number, usageDate: string, toolName: string): Promise<number>;
    tryConsumeDaily(input: {
      externalUserId: string;
      userId: number;
      usageDate: string;
      toolName: string;
      dailyCap: number;
    }): Promise<{ ok: true; countAfter: number } | { ok: false; count: number }>;
    refundDaily(input: {
      userId: number;
      usageDate: string;
      toolName: string;
    }): Promise<void>;
  }
  ```
- `WriteToolBudgetRepository` constructor: `(repo: Repository<ChatToolDailyUsageEntity>, platform: string)`.

- [ ] **Step 1: Write the types file**

`write-tool-budget.types.ts`:

```ts
export type WriteToolBudgetDeniedReason = 'daily' | 'per_message';

export interface WriteToolBudgetConsumeResult {
  ok: boolean;
  /** Count AFTER a successful consume, or the current count on denial. */
  count: number;
}

export interface WriteToolBudgetRepositoryPort {
  getDailyCount(
    userId: number,
    usageDate: string,
    toolName: string,
  ): Promise<number>;
  tryConsumeDaily(input: {
    externalUserId: string;
    userId: number;
    usageDate: string;
    toolName: string;
    dailyCap: number;
  }): Promise<WriteToolBudgetConsumeResult>;
  refundDaily(input: {
    userId: number;
    usageDate: string;
    toolName: string;
  }): Promise<void>;
}

export interface WriteToolBudgetSettings {
  enabled: boolean;
  timezone: string;
  /** tool name → daily cap. Tools absent here are not budgeted. */
  dailyCaps: Record<string, number>;
  /** tool name → per-message cap. */
  perMessageCaps: Record<string, number>;
  /** External ids that bypass the budget entirely. */
  whitelist: ReadonlySet<string>;
}
```

- [ ] **Step 2: Write the failing repository spec**

`write-tool-budget.repository.spec.ts` — mock the TypeORM `Repository.manager.query`:

```ts
import { WriteToolBudgetRepository } from './write-tool-budget.repository';

function makeRepo(queryImpl: (sql: string, params: unknown[]) => unknown) {
  const query = jest.fn((sql: string, params: unknown[]) =>
    Promise.resolve(queryImpl(sql, params)),
  );
  const repo = { manager: { query } } as never;
  return { repo, query };
}

describe('WriteToolBudgetRepository', () => {
  it('tryConsumeDaily returns ok with countAfter when the upsert returns a row', async () => {
    const { repo } = makeRepo(() => [{ count: 3 }]);
    const sut = new WriteToolBudgetRepository(repo, 'discord');
    const result = await sut.tryConsumeDaily({
      externalUserId: 'ext-1',
      userId: 42,
      usageDate: '2026-08-31',
      toolName: 'precreate_next_exercise',
      dailyCap: 15,
    });
    expect(result).toEqual({ ok: true, count: 3 });
  });

  it('tryConsumeDaily returns not-ok when the upsert is blocked by the cap guard', async () => {
    const { repo } = makeRepo((sql) =>
      sql.includes('INSERT INTO chat_tool_daily_usage') ? [] : [{ count: 15 }],
    );
    const sut = new WriteToolBudgetRepository(repo, 'discord');
    const result = await sut.tryConsumeDaily({
      externalUserId: 'ext-1',
      userId: 42,
      usageDate: '2026-08-31',
      toolName: 'precreate_next_exercise',
      dailyCap: 15,
    });
    expect(result.ok).toBe(false);
    expect(result.count).toBe(15);
  });

  it('getDailyCount reads the row count, 0 when absent', async () => {
    const { repo } = makeRepo(() => []);
    const sut = new WriteToolBudgetRepository(repo, 'zalo');
    expect(
      await sut.getDailyCount(1, '2026-08-31', 'reschedule_study_session'),
    ).toBe(0);
  });

  it('refundDaily issues a GREATEST(count - 1, 0) update scoped by platform', async () => {
    const { repo, query } = makeRepo(() => []);
    const sut = new WriteToolBudgetRepository(repo, 'messenger');
    await sut.refundDaily({
      userId: 7,
      usageDate: '2026-08-31',
      toolName: 'precreate_next_exercise',
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('GREATEST');
    expect(sql).toContain('chat_tool_daily_usage');
    expect(params).toEqual(['messenger', 7, '2026-08-31', 'precreate_next_exercise']);
  });
});
```

- [ ] **Step 3: Run it, verify it fails**

Run: `npx turbo run test --filter=@wispace/chat-metering -- write-tool-budget.repository`
Expected: FAIL — `write-tool-budget.repository` not found.

- [ ] **Step 4: Write the repository**

`write-tool-budget.repository.ts`:

```ts
import type { Repository } from 'typeorm';
import type { ChatToolDailyUsageEntity } from '../entities/chat-tool-daily-usage.entity';
import type {
  WriteToolBudgetConsumeResult,
  WriteToolBudgetRepositoryPort,
} from './write-tool-budget.types';

export class WriteToolBudgetRepository
  implements WriteToolBudgetRepositoryPort
{
  constructor(
    private readonly repo: Repository<ChatToolDailyUsageEntity>,
    private readonly platform: string,
  ) {}

  async getDailyCount(
    userId: number,
    usageDate: string,
    toolName: string,
  ): Promise<number> {
    const rows: Array<{ count: number }> = await this.repo.manager.query(
      `
        SELECT count FROM chat_tool_daily_usage
        WHERE platform = $1 AND user_id = $2 AND usage_date = $3::date AND tool_name = $4
      `,
      [this.platform, userId, usageDate, toolName],
    );
    return rows[0]?.count ?? 0;
  }

  async tryConsumeDaily(input: {
    externalUserId: string;
    userId: number;
    usageDate: string;
    toolName: string;
    dailyCap: number;
  }): Promise<WriteToolBudgetConsumeResult> {
    const rows: Array<{ count: number }> = await this.repo.manager.query(
      `
        INSERT INTO chat_tool_daily_usage
          (platform, external_user_id, user_id, usage_date, tool_name, count)
        VALUES ($1, $2, $3, $4::date, $5, 1)
        ON CONFLICT (platform, user_id, usage_date, tool_name)
        DO UPDATE SET
          count = chat_tool_daily_usage.count + 1,
          external_user_id = EXCLUDED.external_user_id,
          updated_at = now()
        WHERE chat_tool_daily_usage.count < $6
        RETURNING count
      `,
      [
        this.platform,
        input.externalUserId,
        input.userId,
        input.usageDate,
        input.toolName,
        input.dailyCap,
      ],
    );

    if (rows[0]) {
      return { ok: true, count: rows[0].count };
    }

    // Guard blocked the upsert — read the current count for the denial metric.
    const current = await this.getDailyCount(
      input.userId,
      input.usageDate,
      input.toolName,
    );
    return { ok: false, count: current };
  }

  async refundDaily(input: {
    userId: number;
    usageDate: string;
    toolName: string;
  }): Promise<void> {
    await this.repo.manager.query(
      `
        UPDATE chat_tool_daily_usage
        SET count = GREATEST(count - 1, 0), updated_at = now()
        WHERE platform = $1 AND user_id = $2 AND usage_date = $3::date AND tool_name = $4
      `,
      [this.platform, input.userId, input.usageDate, input.toolName],
    );
  }
}
```

> Note on `ON CONFLICT … WHERE … DO NOTHING` semantics: when a conflicting row exists and the `WHERE` predicate is false, the statement affects 0 rows and `RETURNING` yields nothing — this is the "cap reached" branch. When no row exists, the `INSERT` path runs with `count = 1` (always `< cap` for any sane cap ≥ 1). The `WHERE` clause on `ON CONFLICT DO UPDATE` is standard Postgres.

- [ ] **Step 5: Run it, verify it passes**

Run: `npx turbo run test --filter=@wispace/chat-metering -- write-tool-budget.repository`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/chat-metering/src/write-tool-budget
git commit -m "feat(chat-metering): WriteToolBudgetRepository — atomic daily consume/refund (#626)"
```

---

## Task 3: `WriteToolBudgetCore` — enable flag, whitelist, timezone, metric callback

**Files:**
- Create: `packages/chat-metering/src/write-tool-budget/write-tool-budget-core.service.ts`
- Test: `packages/chat-metering/src/write-tool-budget/write-tool-budget-core.service.spec.ts`

**Interfaces:**
- Consumes: `WriteToolBudgetRepositoryPort`, `WriteToolBudgetSettings` (Task 2); `todayInTimezone` from `@wispace/date-utils`; `maskExternalId` from `@wispace/bot-common/masking`.
- Produces:
  ```ts
  export interface WriteToolBudgetCoreDeps {
    onDenied?: (toolName: string, reason: 'daily' | 'per_message') => void;
    logger?: { warn(m: string): void };
  }

  export class WriteToolBudgetCore {
    constructor(repository: WriteToolBudgetRepositoryPort, settings: WriteToolBudgetSettings, deps?: WriteToolBudgetCoreDeps);
    isEnabled(): boolean;
    getPerMessageCap(toolName: string): number | undefined;
    /** Read-only daily gate (reschedule stage). true = allowed / not budgeted / bypassed. */
    checkDailyAllowed(externalUserId: string, userId: number, toolName: string): Promise<boolean>;
    /** Atomic check + consume (precreate). true = consumed / not budgeted / bypassed. */
    consumeDaily(externalUserId: string, userId: number, toolName: string): Promise<boolean>;
    /** Refund one unit (precreate non-success). No-op when disabled / not budgeted. */
    refundDaily(userId: number, toolName: string): Promise<void>;
  }
  ```
- `checkDailyAllowed` / `consumeDaily`: emit `onDenied(toolName, 'daily')` on the deny path. Per-message denials are emitted by the caller in `packages/chat-agent`, not here.

- [ ] **Step 1: Write the failing core spec**

```ts
import { WriteToolBudgetCore } from './write-tool-budget-core.service';
import type { WriteToolBudgetRepositoryPort } from './write-tool-budget.types';

const SETTINGS = {
  enabled: true,
  timezone: 'Asia/Ho_Chi_Minh',
  dailyCaps: { precreate_next_exercise: 15, reschedule_study_session: 8 },
  perMessageCaps: { precreate_next_exercise: 3, reschedule_study_session: 1 },
  whitelist: new Set<string>(['vip-1']),
};

function makeRepo(over: Partial<WriteToolBudgetRepositoryPort> = {}) {
  return {
    getDailyCount: jest.fn().mockResolvedValue(0),
    tryConsumeDaily: jest.fn().mockResolvedValue({ ok: true, count: 1 }),
    refundDaily: jest.fn().mockResolvedValue(undefined),
    ...over,
  } as jest.Mocked<WriteToolBudgetRepositoryPort>;
}

describe('WriteToolBudgetCore', () => {
  it('consumeDaily allows and calls the repo when under cap', async () => {
    const repo = makeRepo();
    const core = new WriteToolBudgetCore(repo, SETTINGS);
    await expect(
      core.consumeDaily('ext-1', 10, 'precreate_next_exercise'),
    ).resolves.toBe(true);
    expect(repo.tryConsumeDaily).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 10, dailyCap: 15, toolName: 'precreate_next_exercise' }),
    );
  });

  it('consumeDaily denies and fires onDenied when the cap is reached', async () => {
    const repo = makeRepo({
      tryConsumeDaily: jest.fn().mockResolvedValue({ ok: false, count: 15 }),
    });
    const onDenied = jest.fn();
    const core = new WriteToolBudgetCore(repo, SETTINGS, { onDenied });
    await expect(
      core.consumeDaily('ext-1', 10, 'precreate_next_exercise'),
    ).resolves.toBe(false);
    expect(onDenied).toHaveBeenCalledWith('precreate_next_exercise', 'daily');
  });

  it('bypasses whitelisted external ids without touching the repo', async () => {
    const repo = makeRepo();
    const core = new WriteToolBudgetCore(repo, SETTINGS);
    await expect(
      core.consumeDaily('vip-1', 10, 'precreate_next_exercise'),
    ).resolves.toBe(true);
    expect(repo.tryConsumeDaily).not.toHaveBeenCalled();
  });

  it('is a no-op passthrough when disabled', async () => {
    const repo = makeRepo();
    const core = new WriteToolBudgetCore(repo, { ...SETTINGS, enabled: false });
    await expect(
      core.consumeDaily('ext-1', 10, 'precreate_next_exercise'),
    ).resolves.toBe(true);
    await expect(
      core.checkDailyAllowed('ext-1', 10, 'reschedule_study_session'),
    ).resolves.toBe(true);
    expect(repo.tryConsumeDaily).not.toHaveBeenCalled();
    expect(repo.getDailyCount).not.toHaveBeenCalled();
  });

  it('checkDailyAllowed returns false and fires onDenied when confirmed count >= cap', async () => {
    const repo = makeRepo({ getDailyCount: jest.fn().mockResolvedValue(8) });
    const onDenied = jest.fn();
    const core = new WriteToolBudgetCore(repo, SETTINGS, { onDenied });
    await expect(
      core.checkDailyAllowed('ext-1', 10, 'reschedule_study_session'),
    ).resolves.toBe(false);
    expect(onDenied).toHaveBeenCalledWith('reschedule_study_session', 'daily');
  });

  it('treats an unbudgeted tool as always allowed', async () => {
    const repo = makeRepo();
    const core = new WriteToolBudgetCore(repo, SETTINGS);
    await expect(
      core.consumeDaily('ext-1', 10, 'some_other_tool'),
    ).resolves.toBe(true);
    expect(repo.tryConsumeDaily).not.toHaveBeenCalled();
  });

  it('refundDaily is a no-op when disabled or unbudgeted', async () => {
    const repo = makeRepo();
    const disabled = new WriteToolBudgetCore(repo, { ...SETTINGS, enabled: false });
    await disabled.refundDaily(10, 'precreate_next_exercise');
    const enabled = new WriteToolBudgetCore(repo, SETTINGS);
    await enabled.refundDaily(10, 'unbudgeted_tool');
    expect(repo.refundDaily).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx turbo run test --filter=@wispace/chat-metering -- write-tool-budget-core`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the core**

```ts
import { todayInTimezone as todayUsageDate } from '@wispace/date-utils';
import { maskExternalId } from '@wispace/bot-common/masking';
import type {
  WriteToolBudgetRepositoryPort,
  WriteToolBudgetSettings,
} from './write-tool-budget.types';

export interface WriteToolBudgetCoreDeps {
  onDenied?: (toolName: string, reason: 'daily' | 'per_message') => void;
  logger?: { warn(message: string): void };
}

const NOOP: Required<WriteToolBudgetCoreDeps> = {
  onDenied: () => undefined,
  logger: { warn: () => undefined },
};

/**
 * Platform-agnostic daily budget engine for mutating LLM tools (#626).
 * Owns: enable flag, whitelist bypass, timezone day-key, deny metric.
 * Per-message caps are exposed for the caller to enforce in memory.
 */
export class WriteToolBudgetCore {
  private readonly deps: Required<WriteToolBudgetCoreDeps>;

  constructor(
    private readonly repository: WriteToolBudgetRepositoryPort,
    private readonly settings: WriteToolBudgetSettings,
    deps: WriteToolBudgetCoreDeps = {},
  ) {
    this.deps = { ...NOOP, ...deps };
  }

  isEnabled(): boolean {
    return this.settings.enabled;
  }

  getPerMessageCap(toolName: string): number | undefined {
    return this.settings.perMessageCaps[toolName];
  }

  async checkDailyAllowed(
    externalUserId: string,
    userId: number,
    toolName: string,
  ): Promise<boolean> {
    const cap = this.capFor(externalUserId, toolName);
    if (cap === undefined) return true;

    const count = await this.repository.getDailyCount(
      userId,
      todayUsageDate(this.settings.timezone),
      toolName,
    );
    if (count >= cap) {
      this.deny(externalUserId, toolName, count, cap);
      return false;
    }
    return true;
  }

  async consumeDaily(
    externalUserId: string,
    userId: number,
    toolName: string,
  ): Promise<boolean> {
    const cap = this.capFor(externalUserId, toolName);
    if (cap === undefined) return true;

    const result = await this.repository.tryConsumeDaily({
      externalUserId,
      userId,
      usageDate: todayUsageDate(this.settings.timezone),
      toolName,
      dailyCap: cap,
    });
    if (!result.ok) {
      this.deny(externalUserId, toolName, result.count, cap);
      return false;
    }
    return true;
  }

  async refundDaily(userId: number, toolName: string): Promise<void> {
    if (!this.settings.enabled) return;
    if (this.settings.dailyCaps[toolName] === undefined) return;
    await this.repository.refundDaily({
      userId,
      usageDate: todayUsageDate(this.settings.timezone),
      toolName,
    });
  }

  /** Effective daily cap, or undefined when enforcement should be skipped. */
  private capFor(externalUserId: string, toolName: string): number | undefined {
    if (!this.settings.enabled) return undefined;
    if (this.settings.whitelist.has(externalUserId)) return undefined;
    return this.settings.dailyCaps[toolName];
  }

  private deny(
    externalUserId: string,
    toolName: string,
    count: number,
    cap: number,
  ): void {
    this.deps.onDenied(toolName, 'daily');
    this.deps.logger.warn(
      `WRITE_TOOL_BUDGET_DENY tool=${toolName} reason=daily ` +
        `externalUserId=${maskExternalId(externalUserId)} used=${count} cap=${cap}`,
    );
  }
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx turbo run test --filter=@wispace/chat-metering -- write-tool-budget-core`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/chat-metering/src/write-tool-budget/write-tool-budget-core.service.ts packages/chat-metering/src/write-tool-budget/write-tool-budget-core.service.spec.ts
git commit -m "feat(chat-metering): WriteToolBudgetCore — enable/whitelist/timezone/deny-metric (#626)"
```

---

## Task 4: Config reader + `PlatformWriteToolBudgetService` NestJS adapter + module wiring

**Files:**
- Create: `packages/chat-metering/src/write-tool-budget/write-tool-budget-config.ts`
- Create: `packages/chat-metering/src/write-tool-budget/platform-write-tool-budget.service.ts`
- Test: `packages/chat-metering/src/write-tool-budget/write-tool-budget-config.spec.ts`
- Modify: `packages/chat-metering/src/chat-metering.module.ts`
- Modify: `packages/chat-metering/src/index.ts`

**Interfaces:**
- Produces:
  ```ts
  export function readWriteToolBudgetConfig(
    get: (key: string) => string | undefined,
  ): WriteToolBudgetSettings;

  export class PlatformWriteToolBudgetService {
    constructor(
      options: { platform: string },
      configService: ConfigService,
      toolDailyUsageRepo: Repository<ChatToolDailyUsageEntity>,
      deps?: { onDenied?: (tool: string, reason: 'daily' | 'per_message') => void },
    );
    isEnabled(): boolean;
    getPerMessageCap(toolName: string): number | undefined;
    perMessageCaps(): Record<string, number>;
    checkDailyAllowed(externalUserId: string, userId: number, toolName: string): Promise<boolean>;
    consumeDaily(externalUserId: string, userId: number, toolName: string): Promise<boolean>;
    refundDaily(userId: number, toolName: string): Promise<void>;
  }
  ```
- `ChatMeteringModule.forPlatform` now also provides and exports `PlatformWriteToolBudgetService` and registers `ChatToolDailyUsageEntity`.
- The `onDenied` callback is wired per-app to `BotMetricsService.incWriteToolBudgetDenied(tool, platform, reason)` — see Tasks 6, 10, 11, 12. `ChatMeteringModule` cannot inject `BotMetricsService` (it is not in that module's scope), so `PlatformWriteToolBudgetService` accepts an **optional** `MetricsPort`-shaped provider via a DI token `WRITE_TOOL_BUDGET_METRICS` that each app binds; default no-op.

- [ ] **Step 1: Write the config-reader test**

`write-tool-budget-config.spec.ts`:

```ts
import { readWriteToolBudgetConfig } from './write-tool-budget-config';

const from = (map: Record<string, string>) => (k: string) => map[k];

describe('readWriteToolBudgetConfig', () => {
  it('applies documented defaults when nothing is set', () => {
    const cfg = readWriteToolBudgetConfig(() => undefined);
    expect(cfg.enabled).toBe(true);
    expect(cfg.timezone).toBe('Asia/Ho_Chi_Minh');
    expect(cfg.dailyCaps).toEqual({
      reschedule_study_session: 8,
      precreate_next_exercise: 15,
    });
    expect(cfg.perMessageCaps).toEqual({
      reschedule_study_session: 1,
      precreate_next_exercise: 3,
    });
    expect(cfg.whitelist.size).toBe(0);
  });

  it('only false/0/no disables', () => {
    expect(readWriteToolBudgetConfig(from({ CHAT_WRITE_TOOL_BUDGET_ENABLED: 'false' })).enabled).toBe(false);
    expect(readWriteToolBudgetConfig(from({ CHAT_WRITE_TOOL_BUDGET_ENABLED: '0' })).enabled).toBe(false);
    expect(readWriteToolBudgetConfig(from({ CHAT_WRITE_TOOL_BUDGET_ENABLED: 'true' })).enabled).toBe(true);
    expect(readWriteToolBudgetConfig(from({ CHAT_WRITE_TOOL_BUDGET_ENABLED: 'anything' })).enabled).toBe(true);
  });

  it('reads overrides and parses the whitelist', () => {
    const cfg = readWriteToolBudgetConfig(
      from({
        CHAT_WRITE_TOOL_DAILY_CAP_PRECREATE: '30',
        CHAT_WRITE_TOOL_PER_MESSAGE_CAP_RESCHEDULE: '2',
        CHAT_USAGE_TIMEZONE: 'UTC',
        CHAT_RATE_LIMIT_WHITELIST_PSIDS: 'a, b ,c',
      }),
    );
    expect(cfg.dailyCaps.precreate_next_exercise).toBe(30);
    expect(cfg.perMessageCaps.reschedule_study_session).toBe(2);
    expect(cfg.timezone).toBe('UTC');
    expect([...cfg.whitelist]).toEqual(['a', 'b', 'c']);
  });

  it('ignores non-positive / non-numeric overrides', () => {
    const cfg = readWriteToolBudgetConfig(
      from({ CHAT_WRITE_TOOL_DAILY_CAP_PRECREATE: '-4', CHAT_WRITE_TOOL_DAILY_CAP_RESCHEDULE: 'x' }),
    );
    expect(cfg.dailyCaps.precreate_next_exercise).toBe(15);
    expect(cfg.dailyCaps.reschedule_study_session).toBe(8);
  });
});
```

- [ ] **Step 2: Run it, verify it fails; then write the config reader**

`write-tool-budget-config.ts`:

```ts
import type { WriteToolBudgetSettings } from './write-tool-budget.types';

const DEFAULT_TIMEZONE = 'Asia/Ho_Chi_Minh';
const DAILY_DEFAULTS = {
  reschedule_study_session: 8,
  precreate_next_exercise: 15,
} as const;
const PER_MESSAGE_DEFAULTS = {
  reschedule_study_session: 1,
  precreate_next_exercise: 3,
} as const;

function positiveIntOr(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function readWriteToolBudgetConfig(
  get: (key: string) => string | undefined,
): WriteToolBudgetSettings {
  const enabledRaw = get('CHAT_WRITE_TOOL_BUDGET_ENABLED')?.trim().toLowerCase();
  const enabled = enabledRaw
    ? !['false', '0', 'no'].includes(enabledRaw)
    : true;

  return {
    enabled,
    timezone: get('CHAT_USAGE_TIMEZONE')?.trim() || DEFAULT_TIMEZONE,
    dailyCaps: {
      reschedule_study_session: positiveIntOr(
        get('CHAT_WRITE_TOOL_DAILY_CAP_RESCHEDULE'),
        DAILY_DEFAULTS.reschedule_study_session,
      ),
      precreate_next_exercise: positiveIntOr(
        get('CHAT_WRITE_TOOL_DAILY_CAP_PRECREATE'),
        DAILY_DEFAULTS.precreate_next_exercise,
      ),
    },
    perMessageCaps: {
      reschedule_study_session: positiveIntOr(
        get('CHAT_WRITE_TOOL_PER_MESSAGE_CAP_RESCHEDULE'),
        PER_MESSAGE_DEFAULTS.reschedule_study_session,
      ),
      precreate_next_exercise: positiveIntOr(
        get('CHAT_WRITE_TOOL_PER_MESSAGE_CAP_PRECREATE'),
        PER_MESSAGE_DEFAULTS.precreate_next_exercise,
      ),
    },
    whitelist: new Set(
      (get('CHAT_RATE_LIMIT_WHITELIST_PSIDS') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  };
}
```

- [ ] **Step 3: Write `PlatformWriteToolBudgetService`**

`platform-write-tool-budget.service.ts` — thin adapter, follow `PlatformChatRateLimitService` style:

```ts
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import type { ChatToolDailyUsageEntity } from '../entities/chat-tool-daily-usage.entity';
import { WriteToolBudgetCore } from './write-tool-budget-core.service';
import { WriteToolBudgetRepository } from './write-tool-budget.repository';
import { readWriteToolBudgetConfig } from './write-tool-budget-config';

export interface WriteToolBudgetMetricsSink {
  incWriteToolBudgetDenied?(
    tool: string,
    platform: string,
    reason: 'daily' | 'per_message',
  ): void;
}

export class PlatformWriteToolBudgetService {
  private readonly logger = new Logger(PlatformWriteToolBudgetService.name);
  private readonly core: WriteToolBudgetCore;
  private readonly platform: string;
  private readonly perMessageCapsMap: Record<string, number>;

  constructor(
    options: { platform: string },
    configService: ConfigService,
    toolDailyUsageRepo: Repository<ChatToolDailyUsageEntity>,
    metrics?: WriteToolBudgetMetricsSink,
  ) {
    this.platform = options.platform;
    const settings = readWriteToolBudgetConfig((k) =>
      configService.get<string>(k),
    );
    this.perMessageCapsMap = settings.perMessageCaps;
    this.core = new WriteToolBudgetCore(
      new WriteToolBudgetRepository(toolDailyUsageRepo, options.platform),
      settings,
      {
        onDenied: (tool, reason) =>
          metrics?.incWriteToolBudgetDenied?.(tool, this.platform, reason),
        logger: { warn: (m) => this.logger.warn(m) },
      },
    );
  }

  isEnabled(): boolean {
    return this.core.isEnabled();
  }

  perMessageCaps(): Record<string, number> {
    return this.perMessageCapsMap;
  }

  getPerMessageCap(toolName: string): number | undefined {
    return this.core.getPerMessageCap(toolName);
  }

  checkDailyAllowed(
    externalUserId: string,
    userId: number,
    toolName: string,
  ): Promise<boolean> {
    return this.core.checkDailyAllowed(externalUserId, userId, toolName);
  }

  consumeDaily(
    externalUserId: string,
    userId: number,
    toolName: string,
  ): Promise<boolean> {
    return this.core.consumeDaily(externalUserId, userId, toolName);
  }

  refundDaily(userId: number, toolName: string): Promise<void> {
    return this.core.refundDaily(userId, toolName);
  }
}
```

- [ ] **Step 4: Wire into `ChatMeteringModule.forPlatform`**

In `packages/chat-metering/src/chat-metering.module.ts`:
- import `ChatToolDailyUsageEntity` and add it to `TypeOrmModule.forFeature([...])`.
- import `PlatformWriteToolBudgetService`.
- add a provider:
  ```ts
  {
    provide: PlatformWriteToolBudgetService,
    useFactory: (
      configService: ConfigService,
      toolDailyUsageRepo: Repository<ChatToolDailyUsageEntity>,
    ) =>
      new PlatformWriteToolBudgetService(
        { platform },
        configService,
        toolDailyUsageRepo,
      ),
    inject: [ConfigService, getRepositoryToken(ChatToolDailyUsageEntity)],
  },
  ```
  (Discord/Zalo pass no metrics sink here — they wire the deny metric via `writeToolBudgetDeniedInc` in the tools options instead, Task 11/12. Keeping the sink optional avoids a cross-module `BotMetricsService` inject.)
- add `PlatformWriteToolBudgetService` to `exports`.

- [ ] **Step 5: Export from the package index**

`packages/chat-metering/src/index.ts` — add:

```ts
export { WriteToolBudgetCore } from './write-tool-budget/write-tool-budget-core.service';
export { WriteToolBudgetRepository } from './write-tool-budget/write-tool-budget.repository';
export { PlatformWriteToolBudgetService } from './write-tool-budget/platform-write-tool-budget.service';
export { readWriteToolBudgetConfig } from './write-tool-budget/write-tool-budget-config';
export type {
  WriteToolBudgetSettings,
  WriteToolBudgetRepositoryPort,
  WriteToolBudgetDeniedReason,
} from './write-tool-budget/write-tool-budget.types';
```

- [ ] **Step 6: Typecheck + test + build the package**

Run: `npx turbo run typecheck test build --filter=@wispace/chat-metering`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/chat-metering/src
git commit -m "feat(chat-metering): PlatformWriteToolBudgetService + config reader + module wiring (#626)"
```

---

## Task 5: Vietnamese denial messages in `@wispace/llm-agent`

**Files:**
- Modify: `packages/llm-agent/src/messages.ts`
- Test: `packages/llm-agent/src/messages.spec.ts` (create if absent; otherwise extend)

**Interfaces:**
- Produces:
  ```ts
  export function buildWriteToolDailyBudgetMessage(toolName: string): string;
  export function buildWriteToolPerMessageBudgetMessage(toolName: string, limit: number): string;
  ```
  Consumed by `packages/chat-agent` (Task 8), `apps/messenger-bot` (Task 10), `apps/discord-bot`/`apps/zalo-bot` composition roots (Tasks 11/12 — passed as `rescheduleBudgetExceededMessage`).

- [ ] **Step 1: Write the failing test**

`packages/llm-agent/src/messages.spec.ts` (append if the file exists):

```ts
import {
  buildWriteToolDailyBudgetMessage,
  buildWriteToolPerMessageBudgetMessage,
} from './messages';

describe('write-tool budget messages (#626)', () => {
  it('daily message names the action per tool', () => {
    expect(buildWriteToolDailyBudgetMessage('reschedule_study_session')).toBe(
      'Bạn đã dùng hết số lần đổi lịch học trong hôm nay rồi. Bạn thử lại vào ngày mai nhé.',
    );
    expect(buildWriteToolDailyBudgetMessage('precreate_next_exercise')).toBe(
      'Bạn đã dùng hết số lần tạo bài tập mới trong hôm nay rồi. Bạn thử lại vào ngày mai nhé.',
    );
  });

  it('per-message message interpolates the limit', () => {
    expect(
      buildWriteToolPerMessageBudgetMessage('precreate_next_exercise', 3),
    ).toBe(
      'Trong một tin nhắn mình chỉ xử lý được tối đa 3 lần tạo bài tập mới thôi. Bạn nhắn lại phần còn lại giúp mình nhé.',
    );
  });

  it('falls back to a generic action label for an unknown tool', () => {
    expect(buildWriteToolDailyBudgetMessage('unknown_tool')).toContain(
      'thao tác này',
    );
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx turbo run test --filter=@wispace/llm-agent -- messages`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement in `messages.ts`** (append near `buildToolCallCapMessage`)

```ts
/**
 * Learner-facing action labels for the mutating tools — used by the
 * per-user write-tool budget denial copy (#626). Server-controlled.
 */
const WRITE_TOOL_ACTION_LABELS: Record<string, string> = {
  reschedule_study_session: 'đổi lịch học',
  precreate_next_exercise: 'tạo bài tập mới',
};

function writeToolAction(toolName: string): string {
  return WRITE_TOOL_ACTION_LABELS[toolName] ?? 'thao tác này';
}

/**
 * Relayable result when a learner has used up a mutating tool's per-day
 * budget (#626). Not an error — the model paraphrases it as a normal limit.
 */
export function buildWriteToolDailyBudgetMessage(toolName: string): string {
  return (
    `Bạn đã dùng hết số lần ${writeToolAction(toolName)} trong hôm nay rồi. ` +
    'Bạn thử lại vào ngày mai nhé.'
  );
}

/**
 * Relayable result when one learner message asks for more repetitions of a
 * mutating tool than the per-message cap allows (#626).
 */
export function buildWriteToolPerMessageBudgetMessage(
  toolName: string,
  limit: number,
): string {
  return (
    `Trong một tin nhắn mình chỉ xử lý được tối đa ${limit} lần ` +
    `${writeToolAction(toolName)} thôi. Bạn nhắn lại phần còn lại giúp mình nhé.`
  );
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx turbo run test --filter=@wispace/llm-agent -- messages`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent/src/messages.ts packages/llm-agent/src/messages.spec.ts
git commit -m "feat(llm-agent): Vietnamese write-tool budget denial messages (#626)"
```

---

## Task 6: `write_tool_budget_denied_total` metric

**Files:**
- Modify: `packages/bot-metrics/src/bot-metrics.service.ts` (field list ~line 45-83, constructor ~line 100-357, methods ~line 428+)
- Test: `packages/bot-metrics/src/bot-metrics.service.spec.ts` (extend)

**Interfaces:**
- Produces: `BotMetricsService.incWriteToolBudgetDenied(tool: string, platform: string, reason: 'daily' | 'per_message'): void` emitting `${prefix}_write_tool_budget_denied_total{tool,platform,reason}`.

- [ ] **Step 1: Write the failing test** (extend the spec)

```ts
it('exposes write_tool_budget_denied_total with tool/platform/reason labels (#626)', async () => {
  const metrics = new BotMetricsService({ prefix: 'discord', collectDefaults: false });
  metrics.incWriteToolBudgetDenied('precreate_next_exercise', 'discord', 'daily');
  metrics.incWriteToolBudgetDenied('reschedule_study_session', 'discord', 'per_message');
  const out = await metrics.getMetrics();
  expect(out).toContain(
    'discord_write_tool_budget_denied_total{tool="precreate_next_exercise",platform="discord",reason="daily"} 1',
  );
  expect(out).toContain(
    'discord_write_tool_budget_denied_total{tool="reschedule_study_session",platform="discord",reason="per_message"} 1',
  );
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx turbo run test --filter=@wispace/bot-metrics -- bot-metrics`
Expected: FAIL — `incWriteToolBudgetDenied` is not a function.

- [ ] **Step 3: Implement**

- Add field near the other counters (~line 61):
  ```ts
  private writeToolBudgetDenied: Counter;
  ```
- Register in the constructor (near `quotaDenied`, ~line 215):
  ```ts
  this.writeToolBudgetDenied = new Counter({
    name: `${this.prefix}_write_tool_budget_denied_total`,
    help: 'Mutating LLM tool calls denied by the per-user write-tool budget (#626)',
    labelNames: ['tool', 'platform', 'reason'],
    registers: [this.registry],
  });
  ```
- Add the method (near `incQuotaDenied`, ~line 428):
  ```ts
  /** A mutating tool call was denied by the per-user write-tool budget (#626). */
  incWriteToolBudgetDenied(
    tool: string,
    platform: string,
    reason: 'daily' | 'per_message',
  ): void {
    this.writeToolBudgetDenied.inc({ tool, platform, reason });
  }
  ```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx turbo run test --filter=@wispace/bot-metrics -- bot-metrics`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bot-metrics/src/bot-metrics.service.ts packages/bot-metrics/src/bot-metrics.service.spec.ts
git commit -m "feat(bot-metrics): write_tool_budget_denied_total counter (#626)"
```

---

## Task 7: chat-agent write-tool registry + `WriteToolBudgetPort` + guard test

**Files:**
- Create: `packages/chat-agent/src/agent/write-tool-budget.ts`
- Modify: `packages/chat-agent/src/agent/platform-agent.types.ts`
- Modify: `packages/chat-agent/src/index.ts`
- Test: `packages/chat-agent/src/agent/write-tool-budget.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export const WRITE_TOOL_NAMES: readonly ['reschedule_study_session', 'precreate_next_exercise'];
  export type WriteToolName = (typeof WRITE_TOOL_NAMES)[number];
  export function isWriteToolName(name: string): name is WriteToolName;
  /** Non-read_only agent tools deliberately NOT budgeted by #626. */
  export const BUDGET_EXEMPT_TOOLS: ReadonlySet<string>;

  export interface WriteToolBudgetPort {
    checkDailyAllowed(externalUserId: string, userId: number, toolName: string): Promise<boolean>;
    consumeDaily(externalUserId: string, userId: number, toolName: string): Promise<boolean>;
    refundDaily(userId: number, toolName: string): Promise<void>;
  }
  ```
- Adds to `PlatformAgentToolContext`:
  ```ts
  /** In-memory per-turn count of write-tool executions, keyed by tool name.
   *  Enforces the per-message cap (#626); never persisted. */
  writeToolCalls?: Map<string, number>;
  /** Tools whose daily budget unit was consumed this turn — refunded if the
   *  mutation did not ultimately succeed (#626). */
  writeToolDailyConsumed?: Set<string>;
  ```
- Adds to `PlatformAgentToolsOptions`:
  ```ts
  /** Per-user write-tool budget (#626). Absent = enforcement disabled. */
  writeToolBudget?: WriteToolBudgetPort;
  /** tool name → per-message cap (#626). */
  writeToolPerMessageCaps?: Record<string, number>;
  /** Bounded denial metric (#626); no ids. reason is always 'per_message' at
   *  this call site — daily denials are emitted inside WriteToolBudgetCore. */
  writeToolBudgetDeniedInc?: (toolName: string, reason: 'per_message') => void;
  ```
  (import `WriteToolBudgetPort` with `import type { WriteToolBudgetPort } from './write-tool-budget';`)

- [ ] **Step 1: Write the registry module**

`packages/chat-agent/src/agent/write-tool-budget.ts`:

```ts
/**
 * Per-user write-tool budget (#626) — the set of mutating agent tools that
 * carry a per-day + per-message cap, and the narrow port the executor calls.
 */

export const WRITE_TOOL_NAMES = [
  'reschedule_study_session',
  'precreate_next_exercise',
] as const;

export type WriteToolName = (typeof WRITE_TOOL_NAMES)[number];

export function isWriteToolName(name: string): name is WriteToolName {
  return (WRITE_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Non-`read_only` agent tools that are deliberately NOT budgeted by #626:
 * `register_exam_report_notifications` is a no-op on Discord/Zalo and a
 * mapping upsert (not a WISPACE mutation) on Messenger. A NEW mutating tool
 * must be added to WRITE_TOOL_NAMES or here consciously — the guard test
 * fails otherwise.
 */
export const BUDGET_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  'register_exam_report_notifications',
]);

export interface WriteToolBudgetPort {
  /** Read-only daily gate (reschedule stage). true = allowed. */
  checkDailyAllowed(
    externalUserId: string,
    userId: number,
    toolName: string,
  ): Promise<boolean>;
  /** Atomic check + consume of one daily unit (precreate). true = consumed. */
  consumeDaily(
    externalUserId: string,
    userId: number,
    toolName: string,
  ): Promise<boolean>;
  /** Refund one daily unit (precreate non-success). */
  refundDaily(userId: number, toolName: string): Promise<void>;
}
```

- [ ] **Step 2: Write the guard test**

`packages/chat-agent/src/agent/write-tool-budget.spec.ts`:

```ts
import { AGENT_TOOLS, getAgentToolDefinition } from '@wispace/llm-agent';
import {
  BUDGET_EXEMPT_TOOLS,
  WRITE_TOOL_NAMES,
  isWriteToolName,
} from './write-tool-budget';

describe('write-tool budget registry (#626)', () => {
  it('every non-read_only agent tool is either budgeted or explicitly exempt', () => {
    const unclassified = AGENT_TOOLS.filter(
      (t) =>
        t.capability.effect !== 'read_only' &&
        !isWriteToolName(t.name) &&
        !BUDGET_EXEMPT_TOOLS.has(t.name),
    ).map((t) => t.name);
    expect(unclassified).toEqual([]);
  });

  it('every WRITE_TOOL_NAMES entry is a real, non-read_only tool', () => {
    for (const name of WRITE_TOOL_NAMES) {
      const def = getAgentToolDefinition(name);
      expect(def).toBeDefined();
      expect(def!.capability.effect).not.toBe('read_only');
    }
  });
});
```

> If `AGENT_TOOLS` / `getAgentToolDefinition` are not already exported from `@wispace/llm-agent`'s index, import from the internal path the other chat-agent files use (grep `getAgentToolDefinition` in `packages/chat-agent/src`).

- [ ] **Step 3: Run it, verify it passes** (it should pass immediately — this documents the invariant)

Run: `npx turbo run test --filter=@wispace/chat-agent -- write-tool-budget`
Expected: PASS (2 tests).

- [ ] **Step 4: Extend the context + options types**

Edit `packages/chat-agent/src/agent/platform-agent.types.ts`:
- add `import type { WriteToolBudgetPort } from './write-tool-budget';` at the top.
- add the two fields to `PlatformAgentToolContext` (after `linkContext`), copy verbatim from Interfaces above.
- add the three fields to `PlatformAgentToolsOptions` (after `policyDeniedInc`), copy verbatim from Interfaces above.

- [ ] **Step 5: Export from the package index**

`packages/chat-agent/src/index.ts` — add:

```ts
export {
  WRITE_TOOL_NAMES,
  isWriteToolName,
  BUDGET_EXEMPT_TOOLS,
} from './agent/write-tool-budget';
export type { WriteToolName, WriteToolBudgetPort } from './agent/write-tool-budget';
```

- [ ] **Step 6: Typecheck the package**

Run: `npx turbo run typecheck --filter=@wispace/chat-agent`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/chat-agent/src/agent/write-tool-budget.ts packages/chat-agent/src/agent/write-tool-budget.spec.ts packages/chat-agent/src/agent/platform-agent.types.ts packages/chat-agent/src/index.ts
git commit -m "feat(chat-agent): write-tool registry, budget port, guard test (#626)"
```

---

## Task 8: Enforce the budget in `PlatformAgentToolsService` (Discord/Zalo shared executor)

**Files:**
- Modify: `packages/chat-agent/src/agent/platform-agent-tools.service.ts`
- Test: `packages/chat-agent/src/agent/platform-agent-tools.service.spec.ts` (extend)

**Interfaces:**
- Consumes: `WriteToolBudgetPort`, `isWriteToolName`, `WriteToolName` (Task 7); `buildWriteToolDailyBudgetMessage`, `buildWriteToolPerMessageBudgetMessage` (Task 5); `options.writeToolBudget`, `options.writeToolPerMessageCaps`, `options.writeToolBudgetDeniedInc` (Task 7).
- Behavior: between identity resolution (`ctx.userId` set) and `this.dispatch(...)`, run `enforceWriteToolBudget(toolName, ctx)`. On denial return `{ status: 'budget_exceeded', messageHint }` (no `error` key). For `precreate_next_exercise`: consume the daily unit here; after `dispatch` returns, if the result status is not `'created'`, refund.

- [ ] **Step 1: Write failing tests** (extend the existing spec — reuse its existing service factory / options builder; add `writeToolBudget`, `writeToolPerMessageCaps: { precreate_next_exercise: 2, reschedule_study_session: 1 }`, `writeToolBudgetDeniedInc: jest.fn()` to the options)

```ts
describe('write-tool budget (#626)', () => {
  it('precreate: consumes a daily unit before calling the exercise port', async () => {
    const budget = {
      checkDailyAllowed: jest.fn().mockResolvedValue(true),
      consumeDaily: jest.fn().mockResolvedValue(true),
      refundDaily: jest.fn().mockResolvedValue(undefined),
    };
    const svc = makeService({ writeToolBudget: budget }); // exercise port returns { status: 'created', exerciseUrl: 'https://x/y' }
    const result = await svc.execute(
      'precreate_next_exercise',
      '{}',
      makeCtx({ userText: 'cho mình bài tập mới' }),
    );
    expect(budget.consumeDaily).toHaveBeenCalledWith(
      'ext-1',
      10,
      'precreate_next_exercise',
    );
    expect((result as { status?: string }).status).toBe('created');
    expect(budget.refundDaily).not.toHaveBeenCalled();
  });

  it('precreate: returns a relayable budget_exceeded result when the daily cap is hit', async () => {
    const budget = {
      checkDailyAllowed: jest.fn(),
      consumeDaily: jest.fn().mockResolvedValue(false),
      refundDaily: jest.fn(),
    };
    const svc = makeService({ writeToolBudget: budget });
    const result = await svc.execute(
      'precreate_next_exercise',
      '{}',
      makeCtx({ userText: 'cho mình bài tập mới' }),
    );
    expect(result).toEqual({
      status: 'budget_exceeded',
      messageHint:
        'Bạn đã dùng hết số lần tạo bài tập mới trong hôm nay rồi. Bạn thử lại vào ngày mai nhé.',
    });
    expect(exercisePort.precreateNextExercise).not.toHaveBeenCalled();
  });

  it('precreate: refunds the daily unit when the write did not create', async () => {
    const budget = {
      checkDailyAllowed: jest.fn(),
      consumeDaily: jest.fn().mockResolvedValue(true),
      refundDaily: jest.fn().mockResolvedValue(undefined),
    };
    exercisePort.precreateNextExercise.mockResolvedValue({ status: 'finished_all' });
    const svc = makeService({ writeToolBudget: budget });
    await svc.execute('precreate_next_exercise', '{}', makeCtx({ userText: 'cho mình bài tập mới' }));
    expect(budget.refundDaily).toHaveBeenCalledWith(10, 'precreate_next_exercise');
  });

  it('precreate: second call in the same turn hits the per-message cap of 2', async () => {
    const budget = {
      checkDailyAllowed: jest.fn(),
      consumeDaily: jest.fn().mockResolvedValue(true),
      refundDaily: jest.fn(),
    };
    const deniedInc = jest.fn();
    const svc = makeService({
      writeToolBudget: budget,
      writeToolPerMessageCaps: { precreate_next_exercise: 2 },
      writeToolBudgetDeniedInc: deniedInc,
    });
    const ctx = makeCtx({ userText: 'cho mình 3 bài tập mới' });
    await svc.execute('precreate_next_exercise', '{}', ctx);
    await svc.execute('precreate_next_exercise', '{}', ctx);
    const third = await svc.execute('precreate_next_exercise', '{}', ctx);
    expect((third as { status?: string }).status).toBe('budget_exceeded');
    expect((third as { messageHint?: string }).messageHint).toContain('tối đa 2 lần');
    expect(deniedInc).toHaveBeenCalledWith('precreate_next_exercise', 'per_message');
    expect(budget.consumeDaily).toHaveBeenCalledTimes(2);
  });

  it('reschedule: stage-gate denies when checkDailyAllowed is false and never stages', async () => {
    const budget = {
      checkDailyAllowed: jest.fn().mockResolvedValue(false),
      consumeDaily: jest.fn(),
      refundDaily: jest.fn(),
    };
    const svc = makeService({ writeToolBudget: budget });
    const result = await svc.execute(
      'reschedule_study_session',
      JSON.stringify({ calendarId: 1, schedulingMode: 'default_next_day_same_time' }),
      makeCtx({ userText: 'đổi lịch học giúp mình' }),
    );
    expect((result as { status?: string }).status).toBe('budget_exceeded');
    expect(stagePort.stage).not.toHaveBeenCalled();
  });

  it('no budget port wired → tools run unchanged', async () => {
    const svc = makeService({ writeToolBudget: undefined });
    const result = await svc.execute('precreate_next_exercise', '{}', makeCtx({ userText: 'cho mình bài tập mới' }));
    expect((result as { status?: string }).status).toBe('created');
  });

  it('read-only tools never touch the budget', async () => {
    const budget = {
      checkDailyAllowed: jest.fn(),
      consumeDaily: jest.fn(),
      refundDaily: jest.fn(),
    };
    const svc = makeService({ writeToolBudget: budget });
    await svc.execute('get_user_goals', '{}', makeCtx({}));
    expect(budget.checkDailyAllowed).not.toHaveBeenCalled();
    expect(budget.consumeDaily).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them, verify they fail**

Run: `npx turbo run test --filter=@wispace/chat-agent -- platform-agent-tools`
Expected: FAIL — budget not enforced.

- [ ] **Step 3: Implement in `platform-agent-tools.service.ts`**

Add imports:

```ts
import {
  buildWriteToolDailyBudgetMessage,
  buildWriteToolPerMessageBudgetMessage,
} from '@wispace/llm-agent';
import { isWriteToolName, type WriteToolName } from './write-tool-budget';
```

In `execute()`, after the `capability.identity === 'linked_wispace_account'` block (currently line 88-98) and before `try { return await this.dispatch(...) }` (line 100), insert:

```ts
if (isWriteToolName(toolName) && this.options.writeToolBudget && ctx.userId) {
  const denial = await this.enforceWriteToolBudget(toolName, ctx);
  if (denial) return denial;
}
```

Add the private methods:

```ts
private async enforceWriteToolBudget(
  toolName: WriteToolName,
  ctx: PlatformAgentToolContext,
): Promise<{ status: 'budget_exceeded'; messageHint: string } | undefined> {
  const budget = this.options.writeToolBudget!;
  const userId = ctx.userId!;

  // Per-message (in-memory, per turn). reschedule increments here at the
  // staging attempt; precreate increments here too so a flailing model
  // cannot retry-hammer within one turn.
  const perMessageCap = this.options.writeToolPerMessageCaps?.[toolName];
  if (perMessageCap !== undefined) {
    ctx.writeToolCalls ??= new Map();
    const soFar = ctx.writeToolCalls.get(toolName) ?? 0;
    if (soFar >= perMessageCap) {
      this.options.writeToolBudgetDeniedInc?.(toolName, 'per_message');
      return {
        status: 'budget_exceeded',
        messageHint: buildWriteToolPerMessageBudgetMessage(
          toolName,
          perMessageCap,
        ),
      };
    }
    ctx.writeToolCalls.set(toolName, soFar + 1);
  }

  // Daily.
  if (toolName === 'reschedule_study_session') {
    // Stage-gate only — the authoritative consume is at confirm time
    // (packages/reschedule-confirm). Best-effort per Q19.
    const allowed = await budget.checkDailyAllowed(
      ctx.externalUserId,
      userId,
      toolName,
    );
    if (!allowed) {
      return {
        status: 'budget_exceeded',
        messageHint: buildWriteToolDailyBudgetMessage(toolName),
      };
    }
    return undefined;
  }

  // precreate_next_exercise: check + consume now, refunded after dispatch
  // if the result is not a fresh create.
  const consumed = await budget.consumeDaily(
    ctx.externalUserId,
    userId,
    toolName,
  );
  if (!consumed) {
    return {
      status: 'budget_exceeded',
      messageHint: buildWriteToolDailyBudgetMessage(toolName),
    };
  }
  ctx.writeToolDailyConsumed ??= new Set();
  ctx.writeToolDailyConsumed.add(toolName);
  return undefined;
}

private async refundPrecreateBudgetIfNeeded(
  ctx: PlatformAgentToolContext,
  result: unknown,
): Promise<void> {
  if (!ctx.writeToolDailyConsumed?.has('precreate_next_exercise')) return;
  const created =
    !!result &&
    typeof result === 'object' &&
    (result as { status?: unknown }).status === 'created';
  if (created) return;
  await this.options.writeToolBudget?.refundDaily(
    ctx.userId!,
    'precreate_next_exercise',
  );
  ctx.writeToolDailyConsumed.delete('precreate_next_exercise');
}
```

In `dispatch()`, change the `precreate_next_exercise` case (line 269-279) to capture the result and refund:

```ts
case 'precreate_next_exercise': {
  const precreateResult = await executePrecreateExerciseTool(
    ctx,
    this.exercisePort,
    {
      getNotLinkedMessage: this.options.getNotLinkedMessage,
      logger: this.logger,
      cacheInvalidation: this.options.cacheInvalidation,
    },
    signal,
  );
  await this.refundPrecreateBudgetIfNeeded(ctx, precreateResult);
  return precreateResult;
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `npx turbo run test --filter=@wispace/chat-agent -- platform-agent-tools`
Expected: PASS (all new + existing).

- [ ] **Step 5: Typecheck + build + full package test**

Run: `npx turbo run typecheck test build --filter=@wispace/chat-agent`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/chat-agent/src/agent/platform-agent-tools.service.ts packages/chat-agent/src/agent/platform-agent-tools.service.spec.ts
git commit -m "feat(chat-agent): enforce write-tool budget in the shared executor (#626)"
```

---

## Task 9: Confirm-time daily consume in `packages/reschedule-confirm`

**Files:**
- Modify: `packages/reschedule-confirm/src/reschedule-confirm.service.ts` (`RescheduleConfirmationOptions` ~line 114-121; `confirm()` ~line 231-318)
- Test: extend the existing reschedule-confirm service spec (grep `reschedule-confirm` for the `.spec.ts` name — likely `reschedule-confirm.service.spec.ts`)

**Interfaces:**
- Adds to `RescheduleConfirmationOptions<TExternalId>`:
  ```ts
  /** #626: atomically consume one daily write-tool-budget unit for
   *  `reschedule_study_session` BEFORE the calendar write. Returns false when
   *  the learner is over their daily cap — confirm() then aborts with
   *  `rescheduleBudgetExceededMessage` and reverts the pending row. */
  consumeRescheduleBudget?: (userId: number) => Promise<boolean>;
  /** #626: refund the unit consumed above if `rescheduleSession` throws. */
  refundRescheduleBudget?: (userId: number) => Promise<void>;
  /** #626: Vietnamese reply shown when `consumeRescheduleBudget` returns false.
   *  Passed in (not imported) so this package keeps no llm-agent dependency. */
  rescheduleBudgetExceededMessage?: string;
  ```
- `confirm()` flow: after `takeValid` + the `requiresApprovalToken` binding re-check, and **before** the `try { rescheduleSession }`: if `consumeRescheduleBudget` is set, call it; on `false` → `revertToPending` + return `{ confirmed: false, message: rescheduleBudgetExceededMessage ?? <fallback VN> }`. In the existing `catch`, before `revertToPending`, call `refundRescheduleBudget?.(pending.userId)`.

- [ ] **Step 1: Write failing tests** (extend the spec; reuse its existing service-construction helper and a stub `reschedulePort`)

```ts
describe('write-tool daily budget at confirm time (#626)', () => {
  const FIXED_MSG = 'Bạn đã dùng hết số lần đổi lịch học trong hôm nay rồi. Bạn thử lại vào ngày mai nhé.';

  it('aborts the reschedule and reverts the pending row when the daily budget is exhausted', async () => {
    const consume = jest.fn().mockResolvedValue(false);
    const svc = makeService({
      options: {
        consumeRescheduleBudget: consume,
        rescheduleBudgetExceededMessage: FIXED_MSG,
      },
    });
    await stageAPendingReschedule(svc); // helper: stages a valid pending confirmation
    const result = await svc.confirm(EXTERNAL_ID, USER_ID, VALID_NONCE, BINDING);
    expect(result).toEqual({ confirmed: false, message: FIXED_MSG });
    expect(reschedulePort.rescheduleSession).not.toHaveBeenCalled();
    expect(store.revertToPending).toHaveBeenCalled();
  });

  it('consumes exactly one unit on a successful confirm', async () => {
    const consume = jest.fn().mockResolvedValue(true);
    const refund = jest.fn();
    const svc = makeService({
      options: { consumeRescheduleBudget: consume, refundRescheduleBudget: refund },
    });
    await stageAPendingReschedule(svc);
    const result = await svc.confirm(EXTERNAL_ID, USER_ID, VALID_NONCE, BINDING);
    expect(result.confirmed).toBe(true);
    expect(consume).toHaveBeenCalledWith(USER_ID);
    expect(refund).not.toHaveBeenCalled();
  });

  it('refunds the consumed unit when the calendar write throws', async () => {
    const consume = jest.fn().mockResolvedValue(true);
    const refund = jest.fn().mockResolvedValue(undefined);
    reschedulePort.rescheduleSession.mockRejectedValue(new Error('WISPACE 500'));
    const svc = makeService({
      options: { consumeRescheduleBudget: consume, refundRescheduleBudget: refund },
    });
    await stageAPendingReschedule(svc);
    const result = await svc.confirm(EXTERNAL_ID, USER_ID, VALID_NONCE, BINDING);
    expect(result.confirmed).toBe(false);
    expect(refund).toHaveBeenCalledWith(USER_ID);
  });

  it('is unchanged when no budget hooks are provided', async () => {
    const svc = makeService({ options: {} });
    await stageAPendingReschedule(svc);
    const result = await svc.confirm(EXTERNAL_ID, USER_ID, VALID_NONCE, BINDING);
    expect(result.confirmed).toBe(true);
  });
});
```

> If the existing spec has no "stage a valid pending confirmation" helper, build the pending row through `svc.stage(...)` with a `calendarPort.listUpcomingEntries` stub returning a matching `calendarId`, then read the non-enumerable `confirmationToken` via `Object.getOwnPropertyDescriptor(staged, 'confirmationToken')!.value` for `VALID_NONCE`, and set `BINDING = { platform: 'discord', mappingVersion: 'v1' }` matching the stage input.

- [ ] **Step 2: Run them, verify they fail**

Run: `npx turbo run test --filter=@wispace/reschedule-confirm`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Extend `RescheduleConfirmationOptions<TExternalId>` with the three fields above.
- In `confirm()`, immediately before `try {` (current line 278):

```ts
if (this.options.consumeRescheduleBudget) {
  const consumed = await this.options.consumeRescheduleBudget(pending.userId);
  if (!consumed) {
    await this.store.revertToPending(externalId, pending.leaseToken);
    this.logger.log(
      `RESCHEDULE_BUDGET_EXCEEDED externalId=${maskExternalId(String(externalId))}`,
    );
    return {
      confirmed: false,
      message:
        this.options.rescheduleBudgetExceededMessage ??
        'Bạn đã dùng hết số lần đổi lịch học trong hôm nay rồi. Bạn thử lại vào ngày mai nhé.',
    };
  }
}
```

- In the existing `catch (error)` block (line 302), add before `await this.store.revertToPending(...)`:

```ts
await this.options.refundRescheduleBudget?.(pending.userId);
```

- [ ] **Step 4: Run tests, verify pass; then typecheck + build + full package test**

Run: `npx turbo run typecheck test build --filter=@wispace/reschedule-confirm`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/reschedule-confirm/src
git commit -m "feat(reschedule-confirm): consume/refund write-tool daily budget at confirm time (#626)"
```

---

## Task 10: Messenger app wiring

**Files:**
- Modify: `apps/messenger-bot/src/modules/messenger/application/agent/messenger-agent-tools.service.ts`
- Modify: `apps/messenger-bot/src/modules/chat-rate-limit/chat-rate-limit.module.ts`
- Modify: `apps/messenger-bot/src/modules/messenger/chat-pipeline.module.ts`
- Modify: `apps/messenger-bot/src/modules/chat-rate-limit/application/services/chat-idempotency-cleanup-cron.service.ts`
- Modify: `apps/messenger-bot/.env.example`
- Test: extend `apps/messenger-bot/src/modules/messenger/application/agent/messenger-agent-tools.service.spec.ts`

**Interfaces:**
- Consumes: `PlatformWriteToolBudgetService` from `@wispace/chat-metering` (Task 4); `WriteToolBudgetPort`, `isWriteToolName`, `WriteToolName` from `@wispace/chat-agent` (Task 7); `buildWriteToolDailyBudgetMessage`, `buildWriteToolPerMessageBudgetMessage` from `@wispace/llm-agent` (Task 5); `BotMetricsService.incWriteToolBudgetDenied` (Task 6).
- Produces: `MessengerAgentToolsService` enforces the budget with the same rules as Task 8 (shared executor). Messenger's `MessengerRescheduleConfirmationService` passes `consumeRescheduleBudget` / `refundRescheduleBudget` / `rescheduleBudgetExceededMessage` into its underlying `RescheduleConfirmationService` options.

- [ ] **Step 1: Register the entity + provide the budget service**

`apps/messenger-bot/src/modules/chat-rate-limit/chat-rate-limit.module.ts`:
- add `ChatToolDailyUsageEntity` to the `TypeOrmModule.forFeature([...])` list.
- add a provider (follow the file's existing `PlatformChatRateLimitService`-style factory; grep the file for how it builds services and gets `ConfigService` + repo tokens):
  ```ts
  {
    provide: PlatformWriteToolBudgetService,
    useFactory: (
      configService: ConfigService,
      toolDailyUsageRepo: Repository<ChatToolDailyUsageEntity>,
      metrics: BotMetricsService,
    ) =>
      new PlatformWriteToolBudgetService(
        { platform: 'messenger' },
        configService,
        toolDailyUsageRepo,
        metrics,
      ),
    inject: [ConfigService, getRepositoryToken(ChatToolDailyUsageEntity), BotMetricsService],
  },
  ```
  (If `BotMetricsService` is not importable in this module, provide it without the metrics arg and instead pass `writeToolBudgetDeniedInc` for the per-message metric only in step 3; daily denials still log. Prefer wiring the metrics arg — check the module's imports first.)
- export `PlatformWriteToolBudgetService`.

- [ ] **Step 2: Write failing tests** for `MessengerAgentToolsService` — mirror the Task 8 cases (precreate consume/deny/refund/per-message, reschedule stage-gate deny, no-port passthrough, read-only untouched). Reuse the spec's existing harness; add the new optional constructor deps (step 3) as jest mocks.

- [ ] **Step 3: Enforce in `MessengerAgentToolsService`**

- Add three optional injected deps (mirror the existing `MESSENGER_TOOL_IDENTITY_PROVIDER` / `MESSENGER_TOOL_POLICY_DENIED_INC` `@Optional() @Inject(Symbol)` pattern at line 97-107):
  ```ts
  export const MESSENGER_WRITE_TOOL_BUDGET = Symbol('MESSENGER_WRITE_TOOL_BUDGET');
  export const MESSENGER_WRITE_TOOL_PER_MESSAGE_CAPS = Symbol('MESSENGER_WRITE_TOOL_PER_MESSAGE_CAPS');
  export const MESSENGER_WRITE_TOOL_BUDGET_DENIED_INC = Symbol('MESSENGER_WRITE_TOOL_BUDGET_DENIED_INC');
  ```
  ```ts
  @Optional() @Inject(MESSENGER_WRITE_TOOL_BUDGET)
  private readonly writeToolBudget?: WriteToolBudgetPort,
  @Optional() @Inject(MESSENGER_WRITE_TOOL_PER_MESSAGE_CAPS)
  private readonly writeToolPerMessageCaps?: Record<string, number>,
  @Optional() @Inject(MESSENGER_WRITE_TOOL_BUDGET_DENIED_INC)
  private readonly writeToolBudgetDeniedInc?: (tool: string, reason: 'per_message') => void,
  ```
- In `execute()`, after the identity block (line 133-156) and before `try { return await this.dispatch(...) }` (line 158), insert the same guard as Task 8:
  ```ts
  if (isWriteToolName(toolName) && this.writeToolBudget && ctx.userId) {
    const denial = await this.enforceWriteToolBudget(toolName, ctx);
    if (denial) return denial;
  }
  ```
- Add `enforceWriteToolBudget` and `refundPrecreateBudgetIfNeeded` private methods — **identical logic to Task 8 Step 3**, but reading `this.writeToolBudget` / `this.writeToolPerMessageCaps` / `this.writeToolBudgetDeniedInc` instead of `this.options.*`. (Repeat the code; do not import it — Messenger's executor is a separate class.)
- In `dispatch()` `precreate_next_exercise` case (line 214-215), wrap:
  ```ts
  case 'precreate_next_exercise': {
    const precreateResult = await this.precreateNextExercise(ctx, signal);
    await this.refundPrecreateBudgetIfNeeded(ctx, precreateResult);
    return precreateResult;
  }
  ```

- [ ] **Step 4: Wire the DI in `chat-pipeline.module.ts`**

Grep `chat-pipeline.module.ts` for where `MessengerAgentToolsService` is provided (it is a plain `@Injectable` — likely just listed in `providers`). Add value providers so the optional deps resolve:

```ts
{ provide: MESSENGER_WRITE_TOOL_BUDGET, useExisting: PlatformWriteToolBudgetService },
{
  provide: MESSENGER_WRITE_TOOL_PER_MESSAGE_CAPS,
  useFactory: (b: PlatformWriteToolBudgetService) => b.perMessageCaps(),
  inject: [PlatformWriteToolBudgetService],
},
{
  provide: MESSENGER_WRITE_TOOL_BUDGET_DENIED_INC,
  useFactory: (m: BotMetricsService) =>
    (tool: string, reason: 'per_message') =>
      m.incWriteToolBudgetDenied(tool, 'messenger', reason),
  inject: [BotMetricsService],
},
```

Ensure `ChatRateLimitModule` (or whichever module now exports `PlatformWriteToolBudgetService`) is imported by `chat-pipeline.module.ts`. Also confirm `BotMetricsService` is available in this module's injector (it is used widely in messenger — check imports).

- [ ] **Step 5: Wire the reschedule-confirm budget hooks**

Open `apps/messenger-bot/src/modules/messenger/application/services/messenger-reschedule-confirmation.service.ts`. It constructs / wraps a `RescheduleConfirmationService`. Add to the options object it passes:

```ts
consumeRescheduleBudget: (userId: number) =>
  this.writeToolBudget.consumeDaily(/* externalId unknown here */ '', userId, 'reschedule_study_session'),
```

> **Important:** `WriteToolBudgetCore.consumeDaily` takes `externalUserId` only for the whitelist check and the deny log. At confirm time the pending row (`reschedule_confirmations`) has `externalId` — thread it through. If `MessengerRescheduleConfirmationService.confirm` already receives the psid (it does — it is called from the postback handler with the sender psid), pass that. Signature stays `(userId) => Promise<boolean>` by capturing the psid in a closure created per-confirm, OR widen the option to `(userId, externalId) => Promise<boolean>` in Task 9 and thread `pending.externalId`. **Choose the wider signature** — update Task 9's `consumeRescheduleBudget`/`refundRescheduleBudget` to `(userId: number, externalId: string) => …` and pass `pending.externalId` / `String(pending.externalId)`. Re-run Task 9 tests.

Inject `PlatformWriteToolBudgetService` into `MessengerRescheduleConfirmationService` and set:
```ts
refundRescheduleBudget: (userId, _externalId) =>
  this.writeToolBudget.refundDaily(userId, 'reschedule_study_session'),
rescheduleBudgetExceededMessage: buildWriteToolDailyBudgetMessage('reschedule_study_session'),
```

- [ ] **Step 6: Add the retention prune to the Messenger cleanup cron**

`apps/messenger-bot/src/modules/chat-rate-limit/application/services/chat-idempotency-cleanup-cron.service.ts` — find the method that deletes aged `chat_idempotency` rows. Add, in the same handler, a batched delete for `chat_tool_daily_usage`:

```ts
// #626: prune aged write-tool budget counters (self-bounded by the date key,
// kept ~7 days so ops can inspect "who hit caps").
const toolRetentionDays = Number(
  this.configService.get<string>('CHAT_TOOL_DAILY_USAGE_RETENTION_DAYS') ?? '7',
) || 7;
const toolCutoff = new Date();
toolCutoff.setUTCDate(toolCutoff.getUTCDate() - toolRetentionDays);
await this.dataSource.query(
  `DELETE FROM chat_tool_daily_usage WHERE usage_date < $1::date`,
  [toolCutoff.toISOString().slice(0, 10)],
);
```

Match the file's existing style (it may use a repository, `deleteBatched`, or `dataSource.query` — follow whatever is there).

- [ ] **Step 7: `.env.example`**

Append to `apps/messenger-bot/.env.example`:

```dotenv
# Per-user write-tool budget (#626) — mutating LLM tools (reschedule, precreate).
# Defaults are generous; normal use never hits them. Only false/0/no disables.
CHAT_WRITE_TOOL_BUDGET_ENABLED=true
CHAT_WRITE_TOOL_DAILY_CAP_RESCHEDULE=8
CHAT_WRITE_TOOL_DAILY_CAP_PRECREATE=15
CHAT_WRITE_TOOL_PER_MESSAGE_CAP_RESCHEDULE=1
CHAT_WRITE_TOOL_PER_MESSAGE_CAP_PRECREATE=3
CHAT_TOOL_DAILY_USAGE_RETENTION_DAYS=7
```

- [ ] **Step 8: Verify Messenger**

Run: `npx turbo run lint typecheck test build --filter=@wispace/messenger-bot...`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/messenger-bot
git commit -m "feat(messenger): wire per-user write-tool budget + retention prune (#626)"
```

---

## Task 11: Discord app wiring

**Files:**
- Modify: `apps/discord-bot/src/modules/discord-chat/discord-chat.module.ts` (`new PlatformAgentToolsService(...)` at line ~159; the `RescheduleConfirmationService` construction; the `ChatMeteringModule.forPlatform('discord', ...)` import)
- Modify: `apps/discord-bot/.env.example`
- Test: extend the discord-chat module/tools spec if one exists; otherwise rely on the shared `packages/chat-agent` tests + a wiring smoke assert.

**Interfaces:**
- Consumes: `PlatformWriteToolBudgetService` (exported by `ChatMeteringModule.forPlatform`, Task 4); `BotMetricsService`; `buildWriteToolDailyBudgetMessage` (Task 5).
- Produces: `PlatformAgentToolsOptions` passed to `new PlatformAgentToolsService(...)` now includes `writeToolBudget`, `writeToolPerMessageCaps`, `writeToolBudgetDeniedInc`. The Discord `RescheduleConfirmationService` options include `consumeRescheduleBudget` / `refundRescheduleBudget` / `rescheduleBudgetExceededMessage`.

- [ ] **Step 1: Inject `PlatformWriteToolBudgetService`**

`ChatMeteringModule.forPlatform('discord', ...)` already exports it (Task 4). In the `discord-chat.module.ts` provider/factory that builds `PlatformAgentToolsService`, add `PlatformWriteToolBudgetService` and `BotMetricsService` to the factory `inject: [...]` and params.

- [ ] **Step 2: Extend the tools options**

In the object passed as the `options: PlatformAgentToolsOptions` arg to `new PlatformAgentToolsService(...)` (line ~159-205), add:

```ts
writeToolBudget: budgetService, // PlatformWriteToolBudgetService satisfies WriteToolBudgetPort structurally
writeToolPerMessageCaps: budgetService.perMessageCaps(),
writeToolBudgetDeniedInc: (tool, reason) =>
  metrics.incWriteToolBudgetDenied(tool, 'discord', reason),
```

- [ ] **Step 3: Wire the reschedule-confirm hooks**

Find where Discord constructs `new RescheduleConfirmationService(calendarPort, reschedulePort, store, options)`. Add to `options`:

```ts
consumeRescheduleBudget: (userId, externalId) =>
  budgetService.consumeDaily(String(externalId), userId, 'reschedule_study_session'),
refundRescheduleBudget: (userId) =>
  budgetService.refundDaily(userId, 'reschedule_study_session'),
rescheduleBudgetExceededMessage: buildWriteToolDailyBudgetMessage('reschedule_study_session'),
```

Add `PlatformWriteToolBudgetService` to that provider's `inject` list too.

- [ ] **Step 4: `.env.example`**

Append the same six `CHAT_WRITE_TOOL_*` / `CHAT_TOOL_DAILY_USAGE_RETENTION_DAYS` lines as Task 10 Step 7 to `apps/discord-bot/.env.example`.

- [ ] **Step 5: Verify Discord**

Run: `npx turbo run lint typecheck test build --filter=@wispace/discord-bot...`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/discord-bot
git commit -m "feat(discord): wire per-user write-tool budget (#626)"
```

---

## Task 12: Zalo app wiring

**Files:**
- Modify: `apps/zalo-bot/src/modules/zalo-chat/zalo-chat.module.ts` (`new PlatformAgentToolsService(...)` at line ~201; `RescheduleConfirmationService` construction; `ChatMeteringModule.forPlatform('zalo', ...)`)
- Modify: `apps/zalo-bot/.env.example`

**Interfaces:** identical to Task 11 with `platform: 'zalo'` and `metrics.incWriteToolBudgetDenied(tool, 'zalo', reason)`.

> **Zalo caveat:** Zalo's `wispaceExternalId(ctx)` returns the WISPACE `userId` (not `ctx.externalUserId`) — but the budget is keyed on `ctx.userId` and `ctx.externalUserId` regardless, and `ctx.userId` is always set for `linked_wispace_account` tools, so no special handling. The whitelist (`CHAT_RATE_LIMIT_WHITELIST_PSIDS`) is matched against `ctx.externalUserId` (the Zalo uid) — document that in the `.env.example` comment for Zalo ("Zalo: user ids, not PSIDs").

- [ ] **Step 1-3:** Repeat Task 11 Steps 1-3 against `zalo-chat.module.ts`, `platform: 'zalo'`.

- [ ] **Step 4: `.env.example`** — append the same block to `apps/zalo-bot/.env.example` (with the Zalo whitelist comment note).

- [ ] **Step 5: Verify Zalo**

Run: `npx turbo run lint typecheck test build --filter=@wispace/zalo-bot...`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/zalo-bot
git commit -m "feat(zalo): wire per-user write-tool budget (#626)"
```

---

## Task 13: Shared cleanup-cron retention prune (Discord + Zalo)

**Files:**
- Modify: `packages/cleanup-cron/src/platform-cleanup-cron.service.ts` (`handleIdempotencyCleanup` ~line 187-210)
- Test: extend `packages/cleanup-cron/src/platform-cleanup-cron.service.spec.ts` if present (grep); otherwise add a focused spec for the new query.

**Interfaces:**
- Produces: `handleIdempotencyCleanup()` additionally deletes `chat_tool_daily_usage` rows with `usage_date < now() - CHAT_TOOL_DAILY_USAGE_RETENTION_DAYS` (default 7), scoped by `platform`, batched via the existing `deleteBatched` helper.

- [ ] **Step 1: Write the failing test**

```ts
it('idempotency cleanup also prunes aged chat_tool_daily_usage rows (#626)', async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  // reuse the suite's DataSource stub; capture .query calls
  await service.handleIdempotencyCleanup();
  const prune = queries.find((q) => q.sql.includes('chat_tool_daily_usage'));
  expect(prune).toBeDefined();
  expect(prune!.sql).toMatch(/usage_date < /);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx turbo run test --filter=@wispace/cleanup-cron`
Expected: FAIL.

- [ ] **Step 3: Implement** — inside `handleIdempotencyCleanup`, after the `chat_idempotency` `deleteBatched(...)` call, add:

```ts
const toolRetentionDays = this.parseRetentionDays(
  'CHAT_TOOL_DAILY_USAGE_RETENTION_DAYS',
  7,
)();
const toolCutoff = new Date();
toolCutoff.setUTCDate(toolCutoff.getUTCDate() - toolRetentionDays);
await this.deleteBatched(
  'chat_tool_daily_usage',
  `"platform" = $1 AND "usage_date" < $2::date`,
  [this.config.platform, toolCutoff.toISOString().slice(0, 10)],
);
```

- [ ] **Step 4: Run tests, verify pass; typecheck + build**

Run: `npx turbo run typecheck test build --filter=@wispace/cleanup-cron`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cleanup-cron/src
git commit -m "feat(cleanup-cron): prune aged chat_tool_daily_usage rows (#626)"
```

---

## Task 14: Docs + roadmap

**Files:**
- Modify: `docs/edge-cases-roadmap.md`
- Modify: `docs/project-overview.md`

- [ ] **Step 1: `docs/edge-cases-roadmap.md`** — locate the chat rate-limit section (`§4`, "Gaps" list ~line 251-273). Add a resolved row / bullet:

```markdown
- **#626 (done, 2026-08-31)** — per-user daily budget + per-message cap for mutating tools
  (`reschedule_study_session`, `precreate_next_exercise`). Table `chat_tool_daily_usage`,
  `WriteToolBudgetCore` in `packages/chat-metering`, enforced in the tool executor
  (precreate) and the reschedule confirm handler (reschedule). Metric
  `*_write_tool_budget_denied_total{tool,platform,reason}`.
```

- [ ] **Step 2: `docs/project-overview.md`** — in the quota / runbook area, add:

```markdown
### Write-tool budget (#626)

Mutating chat tools are capped per WISPACE user per day and per message, on top of
the inbound-message chat quota:

| Env | Default | Meaning |
| --- | --- | --- |
| `CHAT_WRITE_TOOL_BUDGET_ENABLED` | `true` | Kill-switch; only `false`/`0`/`no` disables |
| `CHAT_WRITE_TOOL_DAILY_CAP_RESCHEDULE` | `8` | Confirmed reschedules / user / day |
| `CHAT_WRITE_TOOL_DAILY_CAP_PRECREATE` | `15` | `precreate_next_exercise` creates / user / day |
| `CHAT_WRITE_TOOL_PER_MESSAGE_CAP_RESCHEDULE` | `1` | Reschedule prompts staged per learner message |
| `CHAT_WRITE_TOOL_PER_MESSAGE_CAP_PRECREATE` | `3` | Precreate calls per learner message |
| `CHAT_TOOL_DAILY_USAGE_RETENTION_DAYS` | `7` | `chat_tool_daily_usage` prune window |

Whitelisted ids (`CHAT_RATE_LIMIT_WHITELIST_PSIDS`) bypass the budget. On breach the
tool returns a Vietnamese "try again tomorrow / next message" result the model relays —
never a turn error. Alert on `rate(<prefix>_write_tool_budget_denied_total[15m])`;
`reason="per_message"` = one message fanning out, `reason="daily"` = sustained grind.
```

- [ ] **Step 3: Commit**

```bash
git add docs/edge-cases-roadmap.md docs/project-overview.md
git commit -m "docs: per-user write-tool budget runbook + roadmap (#626)"
```

---

## Task 15: Full verification + code review

- [ ] **Step 1: Format the whole workspace**

Run: `npx turbo run format`

- [ ] **Step 2: Full gate across every affected workspace**

Run:
```bash
npx turbo run lint typecheck test build \
  --filter=@wispace/chat-metering \
  --filter=@wispace/database \
  --filter=@wispace/llm-agent \
  --filter=@wispace/bot-metrics \
  --filter=@wispace/chat-agent \
  --filter=@wispace/reschedule-confirm \
  --filter=@wispace/cleanup-cron \
  --filter=@wispace/messenger-bot... \
  --filter=@wispace/discord-bot... \
  --filter=@wispace/zalo-bot...
```
Expected: all green. If `'jest'`/`'turbo' is not recognized` → run `npm install` at the repo root (do not use `npm ci --omit=dev`).

- [ ] **Step 3: DB compatibility check**

Run: `npm run database:migration-compatibility` (requires `NODE_ENV=test` + loopback `DB_HOST` — see `.claude/rules/database.md`). Confirms the new migration applies cleanly and no entity drift.

- [ ] **Step 4: Acceptance-criteria checklist** — verify each issue #626 checkbox against the code:
  - [ ] daily cap per write tool, enforced in the executor before the upstream call, shared across three bots (Tasks 8, 10, 11, 12 + confirm-time Task 9)
  - [ ] per-message cap tighter than the round budget (Task 8/10 in-memory counter, defaults 1 / 3 vs `MAX_CALLS_PER_ROUND` 4)
  - [ ] breach returns a relayable Vietnamese result, not a turn error; a test covers the model relaying it (Task 8 `budget_exceeded` result + Task 5 message tests; the shared agent-loop already relays `{status,messageHint}` observations)
  - [ ] idempotent under batch retry; a test covers a retried batch (Task 2 atomic upsert + note in Q12 — add one spec in `packages/chat-agent` or `packages/chat-pipeline` asserting a redelivered batch does not re-enter the executor; if the existing pipeline spec already covers "reserve returns in_flight → flush returns false", reference it here instead of duplicating)
  - [ ] `write_tool_budget_denied_total{tool}` emitted with masked ids (Task 6, labels `tool,platform,reason`, no ids)
  - [ ] read-only tools unaffected (Task 8 test "read-only tools never touch the budget")
  - [ ] generous defaults, documented in `.env` examples (Tasks 10-12 Step 7/4)
  - [ ] format/lint/typecheck/test/build green for `@wispace/chat-agent`, `@wispace/llm-agent`, three bots (Step 2)

- [ ] **Step 5: Code review**

Run `/code-review` (or `superpowers:requesting-code-review`). Address blocking findings; re-run Step 2 after any fix.

- [ ] **Step 6: Final commit if review changes were made**

```bash
git add -A
git commit -m "chore: address review feedback for write-tool budget (#626)"
```

---

## Self-Review

**Spec coverage:**
- Daily cap per write tool, in the executor, shared 3 bots → Tasks 1-4 (engine), 8 (shared executor), 10 (Messenger), 9 (reschedule confirm), 11-12 (Discord/Zalo wiring). ✓
- Per-message cap tighter than round budget → Task 7 (context field) + Task 8/10 (`enforceWriteToolBudget` in-memory counter), defaults 1/3. ✓
- Friendly Vietnamese result, not a turn error, test for relay → Task 5 (messages + tests), Task 8 (`{status:'budget_exceeded', messageHint}`), Task 15 Step 4. ✓
- Idempotent under batch retry, test → Task 2 (atomic `WHERE count < cap`), Q12 rationale, Task 15 Step 4 explicit spec. ✓
- `write_tool_budget_denied_total{tool}` metric, masked ids → Task 6 (`{tool,platform,reason}`, no ids). ✓
- Read-only tools unaffected → Task 7 (`isWriteToolName` gate), Task 8 test. ✓
- Generous defaults documented in `.env` examples → Tasks 10/11/12 + Task 14. ✓
- Green builds for chat-agent, llm-agent, three bots → Task 15 Step 2. ✓
- Retention → Tasks 10 Step 6 (Messenger) + 13 (Discord/Zalo shared cron). ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". App-wiring tasks (10-12) reference `grep` + "follow the existing `PlatformChatRateLimitService`-style factory" — acceptable per the skill's "follow established patterns in existing codebases" clause; the exact provider objects, symbols, and option keys are given inline.

**Type consistency:**
- `WriteToolBudgetPort` methods: `checkDailyAllowed(externalUserId, userId, toolName)`, `consumeDaily(externalUserId, userId, toolName)`, `refundDaily(userId, toolName)` — consistent across Tasks 7, 8, 10, 4 (`PlatformWriteToolBudgetService` exposes the same three + `perMessageCaps()`).
- `RescheduleConfirmationOptions` budget hooks: Task 9 defines `consumeRescheduleBudget` / `refundRescheduleBudget` as `(userId) => …`; Task 10 Step 5 **widens** them to `(userId, externalId) => …` and instructs re-running Task 9 tests — the widening is called out explicitly so Tasks 11-12 use the two-arg form. Implementer must apply the two-arg signature in Task 9 from the start (see Task 10 Step 5 note) — **adjust Task 9 `consumeRescheduleBudget?: (userId: number, externalId: string) => Promise<boolean>` and `refundRescheduleBudget?: (userId: number, externalId: string) => Promise<void>` when implementing.**
- `{ status: 'budget_exceeded', messageHint: string }` — identical shape in Tasks 8 and 10.
- Metric method `incWriteToolBudgetDenied(tool, platform, reason)` — Task 6 defines, Tasks 4/10/11/12 call with the same arg order.
- `readWriteToolBudgetConfig(get)` → `WriteToolBudgetSettings` — Task 4 defines, Task 4 `PlatformWriteToolBudgetService` consumes.

**Resolved inconsistency:** Task 9 signature is corrected to the two-arg `(userId, externalId)` form here — implement it that way directly; ignore the one-arg form shown in Task 9's first draft body and use the note in Task 9 Interfaces + this section.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-31-write-tool-budget.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach?
