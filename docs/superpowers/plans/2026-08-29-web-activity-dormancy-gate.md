# WISPACE Web-Activity Dormancy Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop scheduled outreach (study reminders + daily reports) to learners who have been inactive on the WISPACE web app longer than a configurable window, driven by a webhook WISPACE pushes on each web visit.

**Architecture:** WISPACE `POST`s web-activity pings to messenger-bot, which upserts one row per WISPACE `userId` into a new shared `web_activity` table (`GREATEST` merge — duplicate/out-of-order deliveries are harmless). A shared `WebActivityService` in `@wispace/database` exposes `recordActive()` (write) and `filterDormant(userIds[])` (batched read). All three bots consult `filterDormant` before study-reminder dispatch and before the daily-report LLM call; user-initiated chat is never gated. The feature ships dark behind `WEB_ACTIVITY_GATE_ENABLED=false`.

**Tech Stack:** NestJS 11, TypeORM (raw SQL for the two hot queries), PostgreSQL, `class-validator` DTO, `prom-client` via `@wispace/bot-metrics`, Turborepo + npm workspaces, Jest.

## Global Constraints

- **Fail-open everywhere.** A `userId` with no `web_activity` row is never dormant. On DB error, `filterDormant` logs and returns `[]` (keep sending). Same posture as `WispaceLinkStatusClient` ("unknown never means revoked").
- **Ships dark.** `WEB_ACTIVITY_GATE_ENABLED` default `false`; `WEB_ACTIVITY_DORMANT_DAYS` default `7`. With the gate disabled, `filterDormant` returns `[]` before touching the DB and report crons skip the batch call — no behavior change, no dormancy query.
- **Ingest is always live.** `recordActive()` writes regardless of `WEB_ACTIVITY_GATE_ENABLED`, so history exists when an operator later enables the gate.
- **User-facing strings: Vietnamese. Logs/comments: English.** Cancellation reason string is exactly `recipient dormant (web inactivity)` (ASCII, used as a DB value + metric branch key — do not translate).
- **Config via `ConfigService`**, no hardcoded values; `WEB_ACTIVITY_DORMANT_DAYS` invalid/≤0 → fallback `7` + `logger.warn`; `WEB_ACTIVITY_GATE_ENABLED` truthy only on the exact string `'true'`.
- **Migrations: messenger-bot is the sole runner.** Shared table → entity in `packages/database/src/entities/`, migration in `packages/database/src/migrations/` with a unique timestamp prefix, class name has **no** platform prefix (`CreateWebActivityTable<ts>`). Never rename an existing migration file/class.
- **`packages/database` already imports NestJS** — it is the shared DB layer, not a framework-agnostic package. `WebActivityService` is a normal `@Injectable`, mirroring `CanonicalPlatformService`.
- **Small diffs, correct Clean Architecture layer.** Webhook controller in a new `modules/web-activity/` feature module in messenger-bot (not `scheduler`, not `messenger`).
- **Metric names:** `${prefix}_web_activity_webhook_received_total` (no labels) and `${prefix}_scheduled_send_suppressed_total{feature}` where `feature ∈ {"report","reminder"}`. `prefix ∈ {messenger,discord,zalo}`.
- **Quality gate before "done":** `npx turbo run lint test build --filter=@wispace/messenger-bot... --filter=@wispace/discord-bot... --filter=@wispace/zalo-bot... --filter=@wispace/database --filter=@wispace/study-reminder-shared --filter=@wispace/bot-metrics` plus, from repo root, `npm run database:migration-compatibility` and `npm run database:entity-discovery:test`.

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `packages/database/src/entities/web-activity.entity.ts` | `WebActivityEntity` (create) | 1 |
| `packages/database/src/migrations/1786934000000-CreateWebActivityTable.ts` | `web_activity` DDL (create) | 1 |
| `packages/database/src/typeorm-options.ts` | add `WebActivityEntity` to `SHARED_ENTITIES` (modify) | 1 |
| `packages/database/src/services/web-activity.service.ts` | `WebActivityService` + `normalizeToUtcIso` (create) | 2 |
| `packages/database/src/services/web-activity.service.spec.ts` | unit tests (create) | 2 |
| `packages/database/src/index.ts` | export `WebActivityService`, `WebActivityEntity`, `normalizeToUtcIso` (modify) | 2 |
| `apps/messenger-bot/src/infrastructure/database/typeorm.options.ts` | add `WebActivityEntity` to explicit entity list (modify) | 3 |
| `apps/messenger-bot/src/infrastructure/database/data-source.ts` | add `WebActivityEntity` to CLI entity list (modify) | 3 |
| `apps/messenger-bot/src/infrastructure/database/database.module.ts` | `forFeature` + provide/export `WebActivityService` (modify) | 3 |
| `apps/discord-bot/src/infrastructure/database/database.module.ts` | provide/export `WebActivityService` (modify) | 3 |
| `apps/zalo-bot/src/infrastructure/database/database.module.ts` | provide/export `WebActivityService` (modify) | 3 |
| `packages/bot-metrics/src/bot-metrics.service.ts` | 2 counters + 2 `inc*` wrappers (modify) | 4 |
| `packages/bot-metrics/src/bot-metrics.service.spec.ts` | counter tests (modify/create) | 4 |
| `apps/messenger-bot/src/modules/web-activity/presentation/controllers/web-activity.controller.ts` | `POST /messenger/wispace/web-activity` (create) | 5 |
| `apps/messenger-bot/src/modules/web-activity/presentation/dto/web-activity.dto.ts` | `RecordWebActivityBody` (create) | 5 |
| `apps/messenger-bot/src/modules/web-activity/web-activity.module.ts` | feature module (create) | 5 |
| `apps/messenger-bot/src/modules/web-activity/presentation/controllers/web-activity.controller.spec.ts` | controller test (create) | 5 |
| `apps/messenger-bot/src/app.module.ts` | import `WebActivityModule` (modify) | 5 |
| `packages/study-reminder-shared/src/ports/dispatch-hooks.port.ts` | `onCancelled` gains `reason: string` (modify) | 6 |
| `packages/study-reminder-shared/src/services/study-reminder-dispatch.service.ts` | `filterDormantUserIds` option + dormancy cancel branch + `reason` on all `onCancelled` calls (modify) | 6 |
| `packages/study-reminder-shared/src/services/study-reminder-dispatch.service.spec.ts` | dormancy tests (modify) | 6 |
| `packages/study-reminder-shared/src/services/study-reminder-providers.factory.ts` | `dormancyGate` + `dormancySuppressionMetric` opts (modify) | 7 |
| `packages/study-reminder-shared/src/services/study-reminder-providers.factory.spec.ts` | factory tests (modify) | 7 |
| `apps/messenger-bot/src/modules/study-reminder/study-reminder.module.ts` | wire `filterDormantUserIds` + meter suppression in `DISPATCH_HOOKS` (modify) | 7 |
| `apps/discord-bot/src/modules/discord-study-reminder/discord-study-reminder.module.ts` | pass `dormancyGate` + `dormancySuppressionMetric` (modify) | 7 |
| `apps/zalo-bot/src/modules/zalo-study-reminder/zalo-study-reminder.module.ts` | pass `dormancyGate` + `dormancySuppressionMetric` (modify) | 7 |
| `apps/messenger-bot/src/modules/scheduler/application/services/report-cron.service.ts` | per-page dormancy filter (modify) | 8 |
| `apps/messenger-bot/src/modules/scheduler/scheduler.module.ts` | already imports `DatabaseModule`; inject `WebActivityService` + `BotMetricsService` into `ReportCronService` (modify) | 8 |
| `apps/discord-bot/src/modules/discord-chat/application/services/discord-report-cron.service.ts` | per-page dormancy filter (modify) | 9 |
| `apps/zalo-bot/src/modules/zalo-chat/infrastructure/persistence/zalo-report-cron.service.ts` | per-page dormancy filter (modify) | 10 |
| `packages/database/src/services/privacy-data.service.ts` | delete `web_activity` by userId in `delete()` (modify) | 11 |
| `packages/database/src/services/privacy-data.service.spec.ts` | erasure test (modify) | 11 |
| `docs/project-overview.md`, `.claude/rules/database.md`, `.env.shared.example`, `docs/wispace-integration-guide.md` | docs (modify) | 12 |

---

## Task 1: `web_activity` table — entity + migration

**Files:**
- Create: `packages/database/src/entities/web-activity.entity.ts`
- Create: `packages/database/src/migrations/1786934000000-CreateWebActivityTable.ts`
- Modify: `packages/database/src/typeorm-options.ts:72-82` (add to `SHARED_ENTITIES`)

**Interfaces:**
- Produces: `WebActivityEntity` (TypeORM entity, `@Entity('web_activity')`, columns `userId: number` PK, `lastActiveAt: Date`, `updatedAt: Date`). Table `web_activity(user_id int PK, last_active_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`. No secondary index.

- [ ] **Step 1: Write the entity**

`packages/database/src/entities/web-activity.entity.ts`:
```ts
import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * One row per WISPACE userId. `last_active_at` is the max web-app activity
 * timestamp seen so far (merged with GREATEST on every webhook), so duplicate
 * and out-of-order deliveries are harmless — no idempotency key needed.
 * Self-updating; only grows one row per linked learner; no cleanup cron.
 */
@Entity('web_activity')
export class WebActivityEntity {
  @PrimaryColumn({ name: 'user_id', type: 'int' })
  userId!: number;

  @Column({ name: 'last_active_at', type: 'timestamptz' })
  lastActiveAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
```

- [ ] **Step 2: Write the migration**

`packages/database/src/migrations/1786934000000-CreateWebActivityTable.ts`:
```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWebActivityTable1786934000000 implements MigrationInterface {
  name = 'CreateWebActivityTable1786934000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "web_activity" (
        "user_id" integer NOT NULL,
        "last_active_at" timestamptz NOT NULL,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_web_activity_user_id" PRIMARY KEY ("user_id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "web_activity"`);
  }
}
```

> If `1786934000000` collides with an existing prefix (`bash .github/scripts/check-migration-timestamps.sh packages/database/src/migrations`), bump to the next free `17869350000..` value and rename the class to match.

- [ ] **Step 3: Register in `SHARED_ENTITIES`**

`packages/database/src/typeorm-options.ts` — add the import near the other entity imports and append to the array:
```ts
import { WebActivityEntity } from './entities/web-activity.entity';
// ...
export const SHARED_ENTITIES: EntityClass[] = [
  WebhookDeadLetterEntity,
  WebhookInboundEventEntity,
  ScheduledReportClaimEntity,
  ReportSendJobEntity,
  RescheduleConfirmationEntity,
  CronLeaderLeaseEntity,
  LearnerProfileEntity,
  UserNotificationPreferenceEntity,
  PlatformLinkAuditEventEntity,
  WebActivityEntity,
];
```

- [ ] **Step 4: Build the package**

Run: `npx turbo run build --filter=@wispace/database`
Expected: PASS (no type errors).

- [ ] **Step 5: Verify migration-timestamp check**

Run: `bash .github/scripts/check-migration-timestamps.sh packages/database/src/migrations`
Expected: exit 0 (no duplicate timestamp prefixes).

- [ ] **Step 6: Commit**

```bash
git add packages/database/src/entities/web-activity.entity.ts packages/database/src/migrations/1786934000000-CreateWebActivityTable.ts packages/database/src/typeorm-options.ts
git commit -m "feat(db): add web_activity shared table + migration"
```

---

## Task 2: `WebActivityService`

**Files:**
- Create: `packages/database/src/services/web-activity.service.ts`
- Create: `packages/database/src/services/web-activity.service.spec.ts`
- Modify: `packages/database/src/index.ts:99-104` (export alongside `PrivacyDataService` / `CanonicalPlatformService`)

**Interfaces:**
- Consumes: `WebActivityEntity` (Task 1), `DataSource` (`@InjectDataSource()`), `ConfigService`.
- Produces:
  - `class WebActivityService` — `@Injectable`. Constructor `(dataSource: DataSource, config: ConfigService)`.
    - `get gateEnabled(): boolean`
    - `recordActive(userId: number, activeAt?: string): Promise<void>` — single-statement upsert, `GREATEST` merge, future timestamp clamped with `LEAST(..., now())`. Always writes (ignores `gateEnabled`).
    - `filterDormant(userIds: number[]): Promise<number[]>` — returns the subset with a `web_activity` row older than the threshold. Returns `[]` immediately when `!gateEnabled` or `userIds` is empty; returns `[]` + `logger.warn` on any DB error.
  - `function normalizeToUtcIso(raw: string | undefined, now?: Date): string` — appends `Z` when `raw` has no timezone designator; returns `now.toISOString()` when `raw` is absent or unparseable.

- [ ] **Step 1: Write the failing tests**

`packages/database/src/services/web-activity.service.spec.ts`:
```ts
import { ConfigService } from '@nestjs/config';
import { WebActivityService, normalizeToUtcIso } from './web-activity.service';

function makeConfig(values: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

describe('normalizeToUtcIso', () => {
  it('appends Z when no timezone designator is present', () => {
    expect(normalizeToUtcIso('2026-08-29T10:00:00')).toBe('2026-08-29T10:00:00.000Z');
  });
  it('keeps an explicit offset', () => {
    expect(normalizeToUtcIso('2026-08-29T10:00:00+07:00')).toBe('2026-08-29T03:00:00.000Z');
  });
  it('falls back to now() when absent', () => {
    const now = new Date('2026-08-29T00:00:00.000Z');
    expect(normalizeToUtcIso(undefined, now)).toBe('2026-08-29T00:00:00.000Z');
  });
  it('falls back to now() when unparseable', () => {
    const now = new Date('2026-08-29T00:00:00.000Z');
    expect(normalizeToUtcIso('not-a-date', now)).toBe('2026-08-29T00:00:00.000Z');
  });
});

describe('WebActivityService.filterDormant', () => {
  it('returns [] without querying when the gate is disabled', async () => {
    const query = jest.fn();
    const svc = new WebActivityService(
      { query } as never,
      makeConfig({ WEB_ACTIVITY_GATE_ENABLED: 'false' }),
    );
    expect(await svc.filterDormant([1, 2, 3])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns [] without querying for an empty input', async () => {
    const query = jest.fn();
    const svc = new WebActivityService(
      { query } as never,
      makeConfig({ WEB_ACTIVITY_GATE_ENABLED: 'true' }),
    );
    expect(await svc.filterDormant([])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns the stale userIds when enabled', async () => {
    const query = jest.fn().mockResolvedValue([{ user_id: 2 }]);
    const svc = new WebActivityService(
      { query } as never,
      makeConfig({ WEB_ACTIVITY_GATE_ENABLED: 'true', WEB_ACTIVITY_DORMANT_DAYS: '7' }),
    );
    expect(await svc.filterDormant([1, 2])).toEqual([2]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('web_activity'), [[1, 2], 7]);
  });

  it('fails open on DB error', async () => {
    const query = jest.fn().mockRejectedValue(new Error('conn reset'));
    const svc = new WebActivityService(
      { query } as never,
      makeConfig({ WEB_ACTIVITY_GATE_ENABLED: 'true' }),
    );
    expect(await svc.filterDormant([1])).toEqual([]);
  });

  it('falls back to 7 days on invalid WEB_ACTIVITY_DORMANT_DAYS', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const svc = new WebActivityService(
      { query } as never,
      makeConfig({ WEB_ACTIVITY_GATE_ENABLED: 'true', WEB_ACTIVITY_DORMANT_DAYS: 'abc' }),
    );
    await svc.filterDormant([1]);
    expect(query).toHaveBeenCalledWith(expect.any(String), [[1], 7]);
  });
});

describe('WebActivityService.recordActive', () => {
  it('upserts with GREATEST + LEAST clamp regardless of gate state', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const svc = new WebActivityService(
      { query } as never,
      makeConfig({ WEB_ACTIVITY_GATE_ENABLED: 'false' }),
    );
    await svc.recordActive(42, '2026-08-29T10:00:00Z');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (user_id) DO UPDATE');
    expect(sql).toContain('GREATEST');
    expect(sql).toContain('LEAST($2::timestamptz, now())');
    expect(params).toEqual([42, '2026-08-29T10:00:00.000Z']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest packages/database/src/services/web-activity.service.spec.ts` (from repo root, or `npm test -- web-activity` in `packages/database/`)
Expected: FAIL — `Cannot find module './web-activity.service'`.

- [ ] **Step 3: Write the implementation**

`packages/database/src/services/web-activity.service.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

const DEFAULT_DORMANT_DAYS = 7;
const DORMANT_REASON = 'recipient dormant (web inactivity)';
const TZ_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/;

/** Cancellation reason written to study_reminder_jobs + used as the metric branch key. */
export { DORMANT_REASON };

/**
 * Append 'Z' when an ISO-8601 string carries no timezone designator, so a bare
 * `2026-08-29T10:00:00` is read as UTC rather than the server's local zone.
 * Absent or unparseable input falls back to `now`.
 */
export function normalizeToUtcIso(
  raw: string | undefined,
  now: Date = new Date(),
): string {
  if (!raw) return now.toISOString();
  const trimmed = raw.trim();
  const iso = TZ_SUFFIX.test(trimmed) ? trimmed : `${trimmed}Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? now.toISOString() : parsed.toISOString();
}

/**
 * Shared read/write for WISPACE web-activity dormancy. Mirrors
 * CanonicalPlatformService: a plain @Injectable in @wispace/database using the
 * shared DataSource. Fail-open: disabled gate or any DB error => not dormant.
 */
@Injectable()
export class WebActivityService {
  private readonly logger = new Logger(WebActivityService.name);
  private readonly enabled: boolean;
  private readonly dormantDays: number;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    this.enabled = config.get<string>('WEB_ACTIVITY_GATE_ENABLED') === 'true';
    const rawDays = config.get<string>('WEB_ACTIVITY_DORMANT_DAYS');
    const parsed = Number(rawDays);
    if (rawDays !== undefined && (!Number.isFinite(parsed) || parsed <= 0)) {
      this.logger.warn(
        `WEB_ACTIVITY_DORMANT_DAYS invalid (${rawDays}), using ${DEFAULT_DORMANT_DAYS}`,
      );
    }
    this.dormantDays =
      Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_DORMANT_DAYS;
  }

  get gateEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Upsert one row per userId. Single statement => atomic, no race. GREATEST
   * merge makes duplicate/out-of-order deliveries harmless; LEAST(...,now())
   * clamps a future timestamp. Always writes, even when the gate is disabled.
   */
  async recordActive(userId: number, activeAt?: string): Promise<void> {
    const normalized = normalizeToUtcIso(activeAt);
    await this.dataSource.query(
      `INSERT INTO web_activity (user_id, last_active_at, updated_at)
       VALUES ($1, LEAST($2::timestamptz, now()), now())
       ON CONFLICT (user_id) DO UPDATE
       SET last_active_at = GREATEST(web_activity.last_active_at, LEAST($2::timestamptz, now())),
           updated_at = now()`,
      [userId, normalized],
    );
  }

  /**
   * Subset of `userIds` whose last web activity is older than the threshold.
   * A userId with no row is absent from the result (never dormant).
   * Disabled gate / empty input / DB error => [] (keep sending).
   */
  async filterDormant(userIds: number[]): Promise<number[]> {
    if (!this.enabled || userIds.length === 0) return [];
    try {
      const rows: Array<{ user_id: number }> = await this.dataSource.query(
        `SELECT user_id FROM web_activity
         WHERE user_id = ANY($1::int[])
           AND last_active_at < now() - ($2 || ' days')::interval`,
        [userIds, this.dormantDays],
      );
      return rows.map((r) => Number(r.user_id));
    } catch (err) {
      this.logger.warn(
        `filterDormant failed, treating all as active: ${(err as Error).message}`,
      );
      return [];
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest packages/database/src/services/web-activity.service.spec.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Export from the package barrel**

`packages/database/src/index.ts` — add after the `CanonicalPlatformService` export block:
```ts
export {
  WebActivityService,
  normalizeToUtcIso,
  DORMANT_REASON,
} from './services/web-activity.service';
export { WebActivityEntity } from './entities/web-activity.entity';
```

- [ ] **Step 6: Build the package**

Run: `npx turbo run build test --filter=@wispace/database`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/database/src/services/web-activity.service.ts packages/database/src/services/web-activity.service.spec.ts packages/database/src/index.ts
git commit -m "feat(db): add WebActivityService (record + filterDormant, fail-open)"
```

---

## Task 3: Wire `WebActivityService` into all three apps

**Files:**
- Modify: `apps/messenger-bot/src/infrastructure/database/typeorm.options.ts:26-38` (add `WebActivityEntity` to explicit list)
- Modify: `apps/messenger-bot/src/infrastructure/database/data-source.ts:14-24` (add `WebActivityEntity`)
- Modify: `apps/messenger-bot/src/infrastructure/database/database.module.ts` (`forFeature` + providers + exports)
- Modify: `apps/discord-bot/src/infrastructure/database/database.module.ts` (providers + exports)
- Modify: `apps/zalo-bot/src/infrastructure/database/database.module.ts` (providers + exports)

**Interfaces:**
- Consumes: `WebActivityService`, `WebActivityEntity` from `@wispace/database` (Task 2).
- Produces: `WebActivityService` injectable + exported from each app's `DatabaseModule` (same shape as the existing `CanonicalPlatformService` provider/export).

> Discord & Zalo `buildTypeOrmOptions` and `forFeature` both spread `...SHARED_ENTITIES`, so `WebActivityEntity` flows in automatically — only the provider/export lines change. Messenger lists entities explicitly in three places (`typeorm.options.ts`, `data-source.ts`, `database.module.ts` `forFeature`) so each needs the entity added.

- [ ] **Step 1: Messenger — add entity to `typeorm.options.ts`**

`apps/messenger-bot/src/infrastructure/database/typeorm.options.ts`:
```ts
import { getTypeOrmOptions as buildSharedOptions, SHARED_ENTITIES, WebActivityEntity } from '@wispace/database';
// ...
  const entities = [
    ...SHARED_ENTITIES,
    UserPlatformMappingEntity,
    // ...existing...
    StudyReminderJobEntity,
    WebActivityEntity,
    ...(options?.includeUsers ? [UserEntity] : []),
  ];
```
(`SHARED_ENTITIES` already contains `WebActivityEntity` after Task 1 — the explicit add is belt-and-suspenders and matches how the other shared entities are already double-listed here; if lint flags a duplicate, drop the explicit line and rely on the spread.)

- [ ] **Step 2: Messenger — add entity to CLI `data-source.ts`**

`apps/messenger-bot/src/infrastructure/database/data-source.ts`:
```ts
import { buildCliDataSource, SHARED_ENTITIES, WebActivityEntity } from '@wispace/database';
// ...
export default buildCliDataSource([
  ...SHARED_ENTITIES,
  UserPlatformMappingEntity,
  // ...existing...
  StudyReminderJobEntity,
  WebActivityEntity,
]);
```
(Same note as Step 1 — `SHARED_ENTITIES` already covers it; keep explicit only if the file's style double-lists.)

- [ ] **Step 3: Messenger — `database.module.ts`**

`apps/messenger-bot/src/infrastructure/database/database.module.ts`:
```ts
import {
  createCircuitBreakerDataSourceFactory,
  DbCircuitBreakerService,
  CanonicalPlatformService,
  WebActivityService,
  WebActivityEntity,
  UserNotificationPreferenceEntity,
} from '@wispace/database';
// ...
    TypeOrmModule.forFeature([
      UserPlatformMappingEntity,
      // ...existing...
      UserNotificationPreferenceEntity,
      WebActivityEntity,
    ]),
// ...
  providers: [DbCircuitBreakerService, CanonicalPlatformService, WebActivityService],
  exports: [TypeOrmModule, CanonicalPlatformService, WebActivityService],
```

- [ ] **Step 4: Discord — `database.module.ts`**

`apps/discord-bot/src/infrastructure/database/database.module.ts`:
```ts
import {
  getTypeOrmOptions as buildSharedOptions,
  SHARED_ENTITIES,
  createCircuitBreakerDataSourceFactory,
  DbCircuitBreakerService,
  CanonicalPlatformService,
  WebActivityService,
  UserNotificationPreferenceEntity,
} from '@wispace/database';
// ...
  providers: [DbCircuitBreakerService, CanonicalPlatformService, WebActivityService],
  exports: [TypeOrmModule, CanonicalPlatformService, WebActivityService],
```

- [ ] **Step 5: Zalo — `database.module.ts`**

Same two-line change as Step 4 in `apps/zalo-bot/src/infrastructure/database/database.module.ts` (add `WebActivityService` to the `@wispace/database` import, to `providers`, and to `exports`).

- [ ] **Step 6: Build all three apps**

Run: `npx turbo run build --filter=@wispace/messenger-bot... --filter=@wispace/discord-bot... --filter=@wispace/zalo-bot...`
Expected: PASS (DI resolves `WebActivityService` — it needs only `DataSource` + `ConfigService`, both global).

- [ ] **Step 7: Migration + entity-discovery compatibility**

Run (repo root): `npm run database:migration-compatibility && npm run database:entity-discovery:test`
Expected: PASS — `web_activity` is discovered and present after the canonical migration chain.

> Needs `NODE_ENV=test` + a loopback `DB_HOST` (see `.claude/rules/database.md`). If `'turbo'`/`'jest'` is not recognized, run `npm install` at repo root first.

- [ ] **Step 8: Commit**

```bash
git add apps/*/src/infrastructure/database/
git commit -m "feat: provide WebActivityService in all three DatabaseModules"
```

---

## Task 4: Metrics — two counters on `BotMetricsService`

**Files:**
- Modify: `packages/bot-metrics/src/bot-metrics.service.ts` (field decls ~line 58-72, constructor ~line 184-210, `inc*` wrappers ~line 356-373)
- Modify/Create: `packages/bot-metrics/src/bot-metrics.service.spec.ts`

**Interfaces:**
- Produces on `BotMetricsService`:
  - `incWebActivityWebhookReceived(): void` → `${prefix}_web_activity_webhook_received_total` (no labels).
  - `incScheduledSendSuppressed(feature: 'report' | 'reminder'): void` → `${prefix}_scheduled_send_suppressed_total{feature}`.

- [ ] **Step 1: Write the failing test**

`packages/bot-metrics/src/bot-metrics.service.spec.ts` — add:
```ts
it('exposes web-activity webhook + scheduled-send-suppressed counters', async () => {
  const svc = new BotMetricsService({ prefix: 'test', collectDefaults: false });
  svc.incWebActivityWebhookReceived();
  svc.incScheduledSendSuppressed('report');
  svc.incScheduledSendSuppressed('reminder');
  svc.incScheduledSendSuppressed('reminder');
  const out = await svc.getMetrics();
  expect(out).toContain('test_web_activity_webhook_received_total 1');
  expect(out).toContain('test_scheduled_send_suppressed_total{feature="report"} 1');
  expect(out).toContain('test_scheduled_send_suppressed_total{feature="reminder"} 2');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest packages/bot-metrics/src/bot-metrics.service.spec.ts -t 'web-activity webhook'`
Expected: FAIL — `svc.incWebActivityWebhookReceived is not a function`.

- [ ] **Step 3: Add the counters**

`packages/bot-metrics/src/bot-metrics.service.ts` — add fields beside `reminderDispatch`:
```ts
  private webActivityWebhookReceived: Counter;
  private scheduledSendSuppressed: Counter;
```
In the constructor, after the `reminderDispatch` block:
```ts
    this.webActivityWebhookReceived = new Counter({
      name: `${this.prefix}_web_activity_webhook_received_total`,
      help: 'WISPACE web-activity webhook deliveries received',
      registers: [this.registry],
    });

    this.scheduledSendSuppressed = new Counter({
      name: `${this.prefix}_scheduled_send_suppressed_total`,
      help: 'Scheduled sends suppressed because the learner is dormant on WISPACE web',
      labelNames: ['feature'],
      registers: [this.registry],
    });
```
Add wrappers beside `incReminderDispatch`:
```ts
  /** WISPACE web-activity webhook received (messenger only). */
  incWebActivityWebhookReceived(): void {
    this.webActivityWebhookReceived.inc();
  }

  /** A scheduled send was skipped for a web-inactive learner. */
  incScheduledSendSuppressed(feature: 'report' | 'reminder'): void {
    this.scheduledSendSuppressed.inc({ feature });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx turbo run test build --filter=@wispace/bot-metrics`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bot-metrics/src/bot-metrics.service.ts packages/bot-metrics/src/bot-metrics.service.spec.ts
git commit -m "feat(metrics): add web_activity webhook + scheduled_send_suppressed counters"
```

---

## Task 5: Webhook ingest — `modules/web-activity/` in messenger-bot

**Files:**
- Create: `apps/messenger-bot/src/modules/web-activity/presentation/dto/web-activity.dto.ts`
- Create: `apps/messenger-bot/src/modules/web-activity/presentation/controllers/web-activity.controller.ts`
- Create: `apps/messenger-bot/src/modules/web-activity/presentation/controllers/web-activity.controller.spec.ts`
- Create: `apps/messenger-bot/src/modules/web-activity/web-activity.module.ts`
- Modify: `apps/messenger-bot/src/app.module.ts:39-49` (import `WebActivityModule`)

**Interfaces:**
- Consumes: `WebActivityService` (exported by messenger `DatabaseModule`, Task 3); `InternalApiKeyGuard` from `@wispace/bot-common/guard`; `BotMetricsService` (global, Task 4).
- Produces: `POST /messenger/wispace/web-activity` — body `{ userId: number (positive int), activeAt?: string (ISO 8601) }`, guard `InternalApiKeyGuard`, returns `200 { ok: true }`. Calls `webActivityService.recordActive(userId, activeAt)` then `metrics.incWebActivityWebhookReceived()`.

- [ ] **Step 1: Write the DTO**

`apps/messenger-bot/src/modules/web-activity/presentation/dto/web-activity.dto.ts`:
```ts
import { IsInt, IsISO8601, IsOptional, IsPositive } from 'class-validator';

export class RecordWebActivityBody {
  @IsInt()
  @IsPositive()
  userId!: number;

  @IsOptional()
  @IsISO8601()
  activeAt?: string;
}
```

- [ ] **Step 2: Write the failing controller test**

`apps/messenger-bot/src/modules/web-activity/presentation/controllers/web-activity.controller.spec.ts`:
```ts
import { WebActivityController } from './web-activity.controller';

describe('WebActivityController', () => {
  it('records activity and increments the webhook counter', async () => {
    const recordActive = jest.fn().mockResolvedValue(undefined);
    const incWebActivityWebhookReceived = jest.fn();
    const controller = new WebActivityController(
      { recordActive } as never,
      { incWebActivityWebhookReceived } as never,
    );

    const res = await controller.record({ userId: 42, activeAt: '2026-08-29T10:00:00Z' });

    expect(recordActive).toHaveBeenCalledWith(42, '2026-08-29T10:00:00Z');
    expect(incWebActivityWebhookReceived).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: true });
  });

  it('passes undefined activeAt straight through', async () => {
    const recordActive = jest.fn().mockResolvedValue(undefined);
    const controller = new WebActivityController(
      { recordActive } as never,
      { incWebActivityWebhookReceived: jest.fn() } as never,
    );
    await controller.record({ userId: 7 });
    expect(recordActive).toHaveBeenCalledWith(7, undefined);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx jest apps/messenger-bot/src/modules/web-activity/`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the controller**

`apps/messenger-bot/src/modules/web-activity/presentation/controllers/web-activity.controller.ts`:
```ts
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { InternalApiKeyGuard } from '@wispace/bot-common/guard';
import { BotMetricsService } from '@wispace/bot-metrics';
import { WebActivityService } from '@wispace/database';
import { RecordWebActivityBody } from '../dto/web-activity.dto';

/**
 * WISPACE pushes here on each learner web-app visit. Auth reuses the ops
 * INTERNAL_API_KEY scheme. The upsert is idempotent + order-independent, so
 * there is no idempotency key, durable inbox or retry worker — a missed
 * delivery self-heals on the learner's next web visit.
 */
@Controller('messenger/wispace')
@UseGuards(InternalApiKeyGuard)
export class WebActivityController {
  constructor(
    private readonly webActivityService: WebActivityService,
    private readonly metrics: BotMetricsService,
  ) {}

  @Post('web-activity')
  @HttpCode(200)
  async record(@Body() body: RecordWebActivityBody): Promise<{ ok: true }> {
    await this.webActivityService.recordActive(body.userId, body.activeAt);
    this.metrics.incWebActivityWebhookReceived();
    return { ok: true };
  }
}
```

- [ ] **Step 5: Write the module**

`apps/messenger-bot/src/modules/web-activity/web-activity.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { BotCommonModule } from '@wispace/bot-common/guard';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { WebActivityController } from './presentation/controllers/web-activity.controller';

@Module({
  imports: [BotCommonModule, DatabaseModule],
  controllers: [WebActivityController],
})
export class WebActivityModule {}
```

> Confirm `BotCommonModule` (from `@wispace/bot-common/guard`) is what provides `InternalApiKeyGuard` in this app — grep an existing guarded controller's module (e.g. discord `discord-ops.module.ts`). If the guard is provided differently in messenger, mirror `SchedulerModule`'s setup instead.

- [ ] **Step 6: Register in `AppModule`**

`apps/messenger-bot/src/app.module.ts` — add the import and list it after `SchedulerModule`:
```ts
import { WebActivityModule } from './modules/web-activity/web-activity.module';
// ...
    SchedulerModule,
    WebActivityModule,
```

- [ ] **Step 7: Run tests + build**

Run: `npx jest apps/messenger-bot/src/modules/web-activity/ && npx turbo run build --filter=@wispace/messenger-bot...`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/messenger-bot/src/modules/web-activity/ apps/messenger-bot/src/app.module.ts
git commit -m "feat(messenger): POST /messenger/wispace/web-activity ingest endpoint"
```

---

## Task 6: Study-reminder dispatch — dormancy cancel branch

**Files:**
- Modify: `packages/study-reminder-shared/src/ports/dispatch-hooks.port.ts:42-43` (`onCancelled` payload)
- Modify: `packages/study-reminder-shared/src/services/study-reminder-dispatch.service.ts` (option + branch + 3 `onCancelled` call sites)
- Modify: `packages/study-reminder-shared/src/services/study-reminder-dispatch.service.spec.ts`

**Interfaces:**
- Consumes: `DORMANT_REASON` constant is re-declared locally here as `'recipient dormant (web inactivity)'` (do **not** import `@wispace/database` into `study-reminder-shared` — it already imports only *types* from it). Define `const DORMANT_REASON = 'recipient dormant (web inactivity)';` at the top of the dispatch service.
- Produces:
  - `DispatchHooksPort.onCancelled?(ctx: { jobId: number; externalUserId: string; reason: string }): void` — **`reason` added** (breaking the 0-arg messenger impl; fixed in Task 7).
  - `StudyReminderDispatchServiceOptions.filterDormantUserIds?: (userIds: number[]) => Promise<number[]>` — returns the dormant subset of the numeric userIds collected from due jobs. Called once per dispatch run, right after `preloadDisplayNames`. Errors are logged and treated as "nobody dormant".
  - New cancel branch in `processJob`: a claimed job whose `job.userId` is in the dormant set is `markCancelled(id, leaseToken, DORMANT_REASON)`, fires `onCancelled({ ..., reason: DORMANT_REASON })`, `cancelled += 1`, returns. Jobs with `userId == null` are never gated.

- [ ] **Step 1: Write the failing tests**

`packages/study-reminder-shared/src/services/study-reminder-dispatch.service.spec.ts` — add a `describe('dormancy gate')` mirroring the existing `isSessionStarted` tests. Cases:
```
- dormant recipient: filterDormantUserIds resolves [userId] for the due job ->
  jobRepository.markCancelled called with (jobId, leaseToken, 'recipient dormant (web inactivity)'),
  result.cancelled === 1, messageSender.sendText NOT called,
  hooks.onCancelled called with reason 'recipient dormant (web inactivity)'.
- active recipient in the same batch: second job's userId not in the dormant set ->
  that job is sent normally (cancelled counts only the dormant one).
- job with userId == null: filterDormantUserIds never receives it; job proceeds.
- filterDormantUserIds throws -> logged, no job cancelled for dormancy.
- option absent -> filterDormantUserIds never called, behavior unchanged.
```
Use the spec file's existing `makeJob` / mock `jobRepository` / mock `messageSender` helpers. `filterDormantUserIds` is a `jest.fn()` passed in the `options` arg.

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest packages/study-reminder-shared/src/services/study-reminder-dispatch.service.spec.ts -t dormancy`
Expected: FAIL — option not honored.

- [ ] **Step 3: Extend the hook port**

`packages/study-reminder-shared/src/ports/dispatch-hooks.port.ts`:
```ts
  /** Called when a job is cancelled (session started, link revoked, dormant). */
  onCancelled?(ctx: {
    jobId: number;
    externalUserId: string;
    reason: string;
  }): void;
```

- [ ] **Step 4: Add the option + constant + reason on existing calls**

`packages/study-reminder-shared/src/services/study-reminder-dispatch.service.ts`:

Top of file:
```ts
const DORMANT_REASON = 'recipient dormant (web inactivity)';
```

In `StudyReminderDispatchServiceOptions`:
```ts
  /**
   * Returns the dormant subset of the numeric userIds collected from due jobs.
   * Called once per run after preloadDisplayNames. A dormant recipient's claimed
   * job is cancelled with reason 'recipient dormant (web inactivity)'. Errors
   * are logged and ignored (fail-open: nobody suppressed).
   */
  filterDormantUserIds?: (userIds: number[]) => Promise<number[]>;
```

Add `reason` to the two existing `onCancelled` call sites:
- in `checkMappingBeforeSend`: `this.hooks?.onCancelled?.({ jobId: claimedJob.id, externalUserId: claimedJob.externalUserId, reason: \`link_${state}\` });`
- in the `isSessionStarted` branch: `this.hooks?.onCancelled?.({ jobId: claimedJob.id, externalUserId: claimedJob.externalUserId, reason: 'session already started' });`

- [ ] **Step 5: Compute the dormant set + add the branch**

In `dispatchDueReminders`, immediately after the `preloadDisplayNames` `if` block (around line 117) and before `let claimed = 0;`:
```ts
    let dormantUserIds = new Set<number>();
    if (uniqueUserIds.length > 0 && this.options?.filterDormantUserIds) {
      try {
        dormantUserIds = new Set(
          await this.options.filterDormantUserIds(uniqueUserIds),
        );
      } catch (error) {
        this.logger.warn(
          `Dormancy filter failed, no recipients suppressed: ${errorMessage(error)}`,
        );
      }
    }
```

In `processJob`, inside the `try` block, **immediately before** the `isSessionStarted` check (line ~188):
```ts
        if (
          claimedJob.userId != null &&
          dormantUserIds.has(claimedJob.userId)
        ) {
          await this.jobRepository.markCancelled(
            claimedJob.id,
            leaseToken,
            DORMANT_REASON,
          );
          this.hooks?.onCancelled?.({
            jobId: claimedJob.id,
            externalUserId: claimedJob.externalUserId,
            reason: DORMANT_REASON,
          });
          cancelled += 1;
          return;
        }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx turbo run test --filter=@wispace/study-reminder-shared`
Expected: PASS (new dormancy cases + all existing dispatch cases still green).

- [ ] **Step 7: Commit**

```bash
git add packages/study-reminder-shared/src/ports/dispatch-hooks.port.ts packages/study-reminder-shared/src/services/study-reminder-dispatch.service.ts packages/study-reminder-shared/src/services/study-reminder-dispatch.service.spec.ts
git commit -m "feat(study-reminder): cancel dispatch for web-dormant recipients"
```

---

## Task 7: Wire `filterDormantUserIds` + reminder-suppression metric in all three apps

**Files:**
- Modify: `packages/study-reminder-shared/src/services/study-reminder-providers.factory.ts` (`CreateStudyReminderProvidersOptions` + dispatch factory + optional hooks)
- Modify: `packages/study-reminder-shared/src/services/study-reminder-providers.factory.spec.ts`
- Modify: `apps/messenger-bot/src/modules/study-reminder/study-reminder.module.ts` (`:174-196` hooks, `:221-275` dispatch factory)
- Modify: `apps/discord-bot/src/modules/discord-study-reminder/discord-study-reminder.module.ts`
- Modify: `apps/zalo-bot/src/modules/zalo-study-reminder/zalo-study-reminder.module.ts`

**Interfaces:**
- Consumes: `WebActivityService` (from `@wispace/database`, exported by each `DatabaseModule`); `BotMetricsService` (global).
- Produces:
  - `CreateStudyReminderProvidersOptions` gains:
    - `dormancyGate?: ClassOf<{ filterDormant(userIds: number[]): Promise<number[]> }>` — when set, the dispatch factory injects it and passes `filterDormantUserIds: (ids) => gate.filterDormant(ids)` into dispatch options.
    - `dormancySuppressionMetric?: ClassOf<{ incScheduledSendSuppressed(feature: 'reminder' | 'report'): void }>` — when set (and no `mappingReader`-style custom hooks exist, i.e. discord/zalo), the factory builds a minimal `DISPATCH_HOOKS` provider `{ onCancelled: (ctx) => { if (ctx.reason === 'recipient dormant (web inactivity)') metric.incScheduledSendSuppressed('reminder'); } }` and passes it as the dispatch `hooks` arg.
  - Messenger keeps its hand-wired dispatch factory; adds `filterDormantUserIds` to the options object and `WebActivityService` to `inject`. Messenger's existing `DISPATCH_HOOKS.onCancelled` gains the suppression branch.

- [ ] **Step 1: Factory — add the options + thread them**

`packages/study-reminder-shared/src/services/study-reminder-providers.factory.ts`:

In `CreateStudyReminderProvidersOptions`:
```ts
  /** Discord/Zalo: WebActivityService — enables the dispatch dormancy gate. */
  dormancyGate?: ClassOf<{ filterDormant(userIds: number[]): Promise<number[]> }>;
  /** Discord/Zalo: BotMetricsService — meters reminder suppression via a minimal DISPATCH_HOOKS. */
  dormancySuppressionMetric?: ClassOf<{
    incScheduledSendSuppressed(feature: 'reminder' | 'report'): void;
  }>;
```

Replace the `StudyReminderDispatchService` provider's `useFactory` so it also takes the gate (append to `inject` when present) and passes the option:
```ts
      provide: StudyReminderDispatchService,
      useFactory: (
        jobRepository: StudyReminderJobRepositoryPort,
        messageSender: MessageSenderPort,
        scheduleService: StudyReminderScheduleService,
        mappingReader: MappingReaderPort,
        dormancyGate?: { filterDormant(ids: number[]): Promise<number[]> },
        suppressionMetric?: {
          incScheduledSendSuppressed(f: 'reminder' | 'report'): void;
        },
      ) =>
        new StudyReminderDispatchService(
          jobRepository,
          messageSender,
          scheduleService,
          options.platform,
          suppressionMetric
            ? {
                onCancelled: (ctx) => {
                  if (ctx.reason === 'recipient dormant (web inactivity)') {
                    suppressionMetric.incScheduledSendSuppressed('reminder');
                  }
                },
              }
            : undefined,
          {
            getMappingState: async (externalUserId) => {
              /* ...unchanged... */
            },
            filterDormantUserIds: dormancyGate
              ? (ids) => dormancyGate.filterDormant(ids)
              : undefined,
          },
        ),
      inject: [
        STUDY_REMINDER_JOB_REPOSITORY,
        MESSAGE_SENDER,
        StudyReminderScheduleService,
        MAPPING_READER,
        ...(options.dormancyGate
          ? [{ token: options.dormancyGate, optional: true }]
          : []),
        ...(options.dormancySuppressionMetric
          ? [{ token: options.dormancySuppressionMetric, optional: true }]
          : []),
      ],
```

> The `inject` array length must match the `useFactory` parameter count. When `dormancyGate`/`dormancySuppressionMetric` are absent the trailing params are simply `undefined` — keep the optional `?` on the factory params so the arities line up.

- [ ] **Step 2: Factory spec**

Add to `study-reminder-providers.factory.spec.ts`: when `createStudyReminderProviders({ ..., dormancyGate: FakeGate, dormancySuppressionMetric: FakeMetric })` is built, the `StudyReminderDispatchService` provider's `inject` includes both tokens (optional). Keep it light — assert the provider array shape, not a full Nest bootstrap.

- [ ] **Step 3: Discord module**

`apps/discord-bot/src/modules/discord-study-reminder/discord-study-reminder.module.ts`:
```ts
import { WebActivityService } from '@wispace/database';
import { BotMetricsService } from '@wispace/bot-metrics';
// ...
  imports: [
    TypeOrmModule.forFeature([StudyReminderJobEntity, DiscordAccountLinkEntity]),
    BotCommonModule,
    DiscordOutboundModule,
    WispaceModule,
    DatabaseModule, // if not already transitively available — provides WebActivityService
  ],
  providers: createStudyReminderProviders({
    platform: 'discord',
    mappingTable: 'discord_account_links',
    mappingEntity: DiscordAccountLinkEntity,
    outboundService: DiscordOutboundService,
    calendarService: WispaceCalendarService,
    dormancyGate: WebActivityService,
    dormancySuppressionMetric: BotMetricsService,
  }),
```

> Verify `WebActivityService` is resolvable here: it is exported by `DatabaseModule` (Task 3). If `DiscordStudyReminderModule` doesn't already import `DatabaseModule` (directly or via another imported module), add it to `imports`. `BotMetricsService` is global — no import needed.

- [ ] **Step 4: Zalo module**

Same change as Step 3 in `apps/zalo-bot/src/modules/zalo-study-reminder/zalo-study-reminder.module.ts` (`platform: 'zalo'`, `mappingTable: 'zalo_account_links'`, `mappingEntity: ZaloAccountLinkEntity`, add `dormancyGate: WebActivityService`, `dormancySuppressionMetric: BotMetricsService`, ensure `DatabaseModule` is imported).

- [ ] **Step 5: Messenger module**

`apps/messenger-bot/src/modules/study-reminder/study-reminder.module.ts`:

In the `DISPATCH_HOOKS` factory (`:174`), change `onCancelled`:
```ts
        onCancelled: (ctx) => {
          metrics.incReminderDispatch('cancelled');
          if (ctx.reason === 'recipient dormant (web inactivity)') {
            metrics.incScheduledSendSuppressed('reminder');
          }
        },
```

In the `StudyReminderDispatchService` factory (`:222`), add `WebActivityService` to the `useFactory` params + `inject`, and add the option:
```ts
      useFactory: (
        jobRepository, messageSender, scheduleService, hooks,
        sessionSource, reminderService, mappingReader,
        webActivity: WebActivityService,
      ) =>
        new StudyReminderDispatchService(
          jobRepository, messageSender, scheduleService, 'messenger', hooks,
          {
            getMappingState: /* ...unchanged... */,
            backoffMode: 'flat',
            preloadDisplayNames: (userIds) => reminderService.preloadDisplayNames(userIds),
            classifyFailure: /* ...unchanged... */,
            filterDormantUserIds: (ids) => webActivity.filterDormant(ids),
          },
        ),
      inject: [
        STUDY_REMINDER_JOB_REPOSITORY, MESSAGE_SENDER, StudyReminderScheduleService,
        DISPATCH_HOOKS, StudySessionSourceService, StudyReminderService, MAPPING_READER,
        WebActivityService,
      ],
```
Add `import { WebActivityService } from '@wispace/database';`. `StudyReminderModule` already imports `DatabaseModule` transitively via `SchedulerModule`? — it must import `DatabaseModule` directly for `WebActivityService` to resolve here; add it to `imports` if absent.

- [ ] **Step 6: Build + test the three apps and the package**

Run: `npx turbo run test build --filter=@wispace/study-reminder-shared --filter=@wispace/messenger-bot... --filter=@wispace/discord-bot... --filter=@wispace/zalo-bot...`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/study-reminder-shared/ apps/messenger-bot/src/modules/study-reminder/ apps/discord-bot/src/modules/discord-study-reminder/ apps/zalo-bot/src/modules/zalo-study-reminder/
git commit -m "feat(study-reminder): wire web-activity dormancy gate in all three bots"
```

---

## Task 8: Daily report cron dormancy filter — messenger

**Files:**
- Modify: `apps/messenger-bot/src/modules/scheduler/application/services/report-cron.service.ts` (constructor + `sendScheduledReports` page loop)
- Modify: `apps/messenger-bot/src/modules/scheduler/scheduler.module.ts` (no change if `DatabaseModule` already imported — it is, line 47; `BotMetricsService` is global)

**Interfaces:**
- Consumes: `WebActivityService.filterDormant`, `BotMetricsService.incScheduledSendSuppressed`.
- Produces: after fetching each `page`, when `webActivityService.gateEnabled`, the mappings whose `userId` is in `filterDormant(pageUserIds)` are dropped before `runBatched`; each drop calls `metrics.incScheduledSendSuppressed('report')` and counts toward `skipped`.

- [ ] **Step 1: Write the failing test**

In `report-cron.service.spec.ts` (or a new `*.dormancy.spec.ts` beside it): given a page of two mappings (`userId` 1 and 2), `webActivityService.gateEnabled = true`, `filterDormant([1,2])` resolves `[2]` → `processMappingForReport` is invoked only for `userId` 1; `metrics.incScheduledSendSuppressed` called once with `'report'`; result `skipped` includes the dropped one. With `gateEnabled = false`, `filterDormant` is never called.

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest apps/messenger-bot/src/modules/scheduler/application/services/report-cron`
Expected: FAIL.

- [ ] **Step 3: Inject the dependencies**

`report-cron.service.ts` constructor — add:
```ts
    private readonly webActivityService: WebActivityService,
    private readonly metrics: BotMetricsService,
```
Imports: `import { WebActivityService } from '@wispace/database';` and `import { BotMetricsService } from '@wispace/bot-metrics';`.
Add `WebActivityService` + `BotMetricsService` to `SchedulerModule` `providers`? — `WebActivityService` comes from the imported `DatabaseModule` export, `BotMetricsService` is global; neither needs a `providers` entry. No module change required.

- [ ] **Step 4: Filter each page**

In `sendScheduledReports`, right after `let mappings = page;` / the `psidFilter` filter and before `totalMappings += mappings.length;`:
```ts
      if (this.webActivityService.gateEnabled) {
        const pageUserIds = mappings
          .map((m) => m.userId)
          .filter((id): id is number => typeof id === 'number');
        const dormant = new Set(
          await this.webActivityService.filterDormant(pageUserIds),
        );
        if (dormant.size > 0) {
          const before = mappings.length;
          mappings = mappings.filter(
            (m) => !(m.userId != null && dormant.has(m.userId)),
          );
          const suppressed = before - mappings.length;
          for (let i = 0; i < suppressed; i += 1) {
            this.metrics.incScheduledSendSuppressed('report');
          }
          skipped += suppressed;
        }
      }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx turbo run test build --filter=@wispace/messenger-bot...`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/messenger-bot/src/modules/scheduler/
git commit -m "feat(messenger): suppress daily report for web-dormant learners"
```

---

## Task 9: Daily report cron dormancy filter — discord

**Files:**
- Modify: `apps/discord-bot/src/modules/discord-chat/application/services/discord-report-cron.service.ts` (constructor + `sendScheduledReports` page loop)

**Interfaces:**
- Consumes: `WebActivityService.filterDormant`, `BotMetricsService.incScheduledSendSuppressed`.
- Produces: within `sendScheduledReports`, after `const page = await this.loadPage(cursor);` and the empty-check, when `webActivityService.gateEnabled` the page rows whose `userId` is dormant are removed before `runBatched`; each removal increments `skipped` and `metrics.incScheduledSendSuppressed('report')`.

- [ ] **Step 1: Write the failing test**

`discord-report-cron.service.spec.ts`: page of two links (`userId` 10, 20), gate enabled, `filterDormant([10,20]) -> [20]` → `orchestrationService.claimAndSend` called only for link 10; `incScheduledSendSuppressed('report')` once. Gate disabled → `filterDormant` not called.

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest apps/discord-bot/src/modules/discord-chat/application/services/discord-report-cron`
Expected: FAIL.

- [ ] **Step 3: Inject + filter**

Constructor — add `private readonly webActivityService: WebActivityService,` and `private readonly metrics: BotMetricsService,` (imports from `@wispace/database` and `@wispace/bot-metrics`; both resolvable — `DatabaseModule` is imported by the discord report module, `BotMetricsService` is global). In `sendScheduledReports`, replace `const page = await this.loadPage(cursor); if (page.length === 0) break; total += page.length;` with:
```ts
      let page = await this.loadPage(cursor);
      if (page.length === 0) break;
      const rawPageLen = page.length;
      if (this.webActivityService.gateEnabled) {
        const ids = page
          .map((l) => l.userId)
          .filter((id): id is number => typeof id === 'number');
        const dormant = new Set(await this.webActivityService.filterDormant(ids));
        if (dormant.size > 0) {
          const before = page.length;
          page = page.filter((l) => !(l.userId != null && dormant.has(l.userId)));
          const suppressed = before - page.length;
          for (let i = 0; i < suppressed; i += 1) {
            this.metrics.incScheduledSendSuppressed('report');
          }
          skipped += suppressed;
        }
      }
      total += page.length;
```
Keep the cursor / `hasMore` logic keyed off the **unfiltered** page: `cursor = ` still needs the last id of the page actually read — capture it before filtering:
```ts
      // after loadPage, before filtering:
      const lastId = page[page.length - 1].id;
      // ...filter...
      cursor = lastId;
      hasMore = rawPageLen === PAGE_SIZE;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx turbo run test build --filter=@wispace/discord-bot...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/discord-bot/src/modules/discord-chat/
git commit -m "feat(discord): suppress daily report for web-dormant learners"
```

---

## Task 10: Daily report cron dormancy filter — zalo

**Files:**
- Modify: `apps/zalo-bot/src/modules/zalo-chat/infrastructure/persistence/zalo-report-cron.service.ts` (constructor + `sendDailyReports` page loop)

**Interfaces:**
- Consumes: `WebActivityService.filterDormant`, `BotMetricsService.incScheduledSendSuppressed`.
- Produces: in `sendDailyReports`, after `const page = await this.loadPage(cursor);` and the empty-check, dormant rows are removed before `runBatched` when the gate is enabled; each removal increments `skipped` and `metrics.incScheduledSendSuppressed('report')`. Cursor/`hasMore` stay keyed off the raw page length.

- [ ] **Step 1: Write the failing test**

`zalo-report-cron.service.spec.ts` (create if absent): page of two links (`userId` 5, 6), gate enabled, `filterDormant([5,6]) -> [5]` → `sendReportForUser` invoked only for link 6; `incScheduledSendSuppressed('report')` once; `skipped` incremented. Gate disabled → `filterDormant` not called.

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest apps/zalo-bot/src/modules/zalo-chat/infrastructure/persistence/zalo-report-cron`
Expected: FAIL.

- [ ] **Step 3: Inject + filter**

Constructor — add `@Optional() @Inject(WebActivityService) private readonly webActivityService?: WebActivityService,` and `private readonly metrics: BotMetricsService,` (mirror the existing `@Optional() @Inject(CanonicalPlatformService)` style; import `WebActivityService` from `@wispace/database`, `BotMetricsService` from `@wispace/bot-metrics`). In `sendDailyReports`:
```ts
      let page = await this.loadPage(cursor);
      if (page.length === 0) break;
      const rawPageLen = page.length;
      const lastId = page[page.length - 1].id;
      if (this.webActivityService?.gateEnabled) {
        const ids = page
          .map((l) => l.userId)
          .filter((id): id is number => typeof id === 'number');
        const dormant = new Set(await this.webActivityService.filterDormant(ids));
        if (dormant.size > 0) {
          const before = page.length;
          page = page.filter((l) => !(l.userId != null && dormant.has(l.userId)));
          const suppressed = before - page.length;
          for (let i = 0; i < suppressed; i += 1) {
            this.metrics.incScheduledSendSuppressed('report');
          }
          skipped += suppressed;
        }
      }
      total += page.length;
      // ...runBatched over the filtered page...
      cursor = lastId;
      hasMore = rawPageLen === PAGE_SIZE;
```

> `ZaloReportCronService` lives under `infrastructure/persistence/` (pre-existing layering quirk) — leave that as-is; just add the two deps.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx turbo run test build --filter=@wispace/zalo-bot...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/zalo-bot/src/modules/zalo-chat/
git commit -m "feat(zalo): suppress daily report for web-dormant learners"
```

---

## Task 11: Privacy erasure — delete `web_activity` rows

**Files:**
- Modify: `packages/database/src/services/privacy-data.service.ts` (`ENTITY_NAMES` + `delete()` userId-scoped block ~line 293-304, doc comment ~line 27-45)
- Modify: `packages/database/src/services/privacy-data.service.spec.ts`

**Interfaces:**
- Consumes: `WebActivityEntity` (`@Entity('web_activity')` → repository name `'WebActivity'`).
- Produces: `delete()` removes the learner's `web_activity` row **by `userId`** inside the existing transaction. `unlink()` is **not** touched (per-platform revoke; the shared row may still back another active platform link). When the erased mapping has no `userId`, `web_activity` (keyed by `userId` only) has no match — the row is left as a harmless orphan (documented, no cleanup cron).

- [ ] **Step 1: Write the failing test**

`privacy-data.service.spec.ts` — in the `delete()` describe block, assert that when `userId` is resolved, `manager.getRepository('WebActivity').delete({ userId })` is invoked (mirror the existing assertions for `studyReminderJob` / `chatDailyUsage`). Add a second case: when the mapping has no `userId`, `web_activity` delete is **not** attempted with `{ platform, externalUserId }` (it has no such columns) — `deleteByUser('WebActivity', undefined)` must be a no-op / skipped.

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest packages/database/src/services/privacy-data.service.spec.ts -t delete`
Expected: FAIL — `web_activity` not deleted.

- [ ] **Step 3: Implement**

`privacy-data.service.ts`:

Add to `ENTITY_NAMES`:
```ts
  webActivity: 'WebActivity',
```

In `delete()`, the `1c` block — `web_activity` is **userId-only**, so guard it (unlike the others which fall back to `(platform, externalUserId)`):
```ts
      await deleteByUser(ENTITY_NAMES.learnerProfile, uid);
      await deleteByUser(ENTITY_NAMES.studyReminderJob, uid);
      await deleteByUser(ENTITY_NAMES.scheduledReportClaim, uid);
      await deleteByUser(ENTITY_NAMES.reportSendJob, uid);
      if (uid) {
        // web_activity is keyed by userId only — no (platform, externalUserId) fallback.
        // A mapping with no userId leaves a harmless orphan row (no cleanup cron).
        await manager.getRepository(ENTITY_NAMES.webActivity).delete({ userId: uid });
      }
```

Update the class doc comment ("Delete scope" list) to add `- Web activity (userId-scoped; orphan row kept when mapping has no userId)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx turbo run test build --filter=@wispace/database`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/database/src/services/privacy-data.service.ts packages/database/src/services/privacy-data.service.spec.ts
git commit -m "feat(privacy): erase web_activity rows on user deletion"
```

---

## Task 12: Documentation

**Files:**
- Modify: `docs/project-overview.md` (endpoint + gate behavior + privacy note + WISPACE debounce recommendation)
- Modify: `.claude/rules/database.md` (`web_activity` row in the Tables list + orphan note + new migration in the ownership table)
- Modify: `.env.shared.example` (add the two vars to the Vault-stored list comment)
- Modify: `docs/wispace-integration-guide.md` (webhook contract: method, path, auth header, body, `activeAt` should carry `Z`/offset, debounce guidance)

**Interfaces:** none (prose only).

- [ ] **Step 1: `docs/project-overview.md`**

Add a "WISPACE web-activity dormancy gate" subsection under the API/cron area:
- `POST /messenger/wispace/web-activity` — auth `X-Internal-Api-Key` / `Authorization: Bearer` = `INTERNAL_API_KEY`. Body `{ userId: number (positive int), activeAt?: ISO 8601 }`. `activeAt` defaults to `now()`, a future value is clamped, offset-less strings are read as UTC. Idempotent `GREATEST` upsert into `web_activity`; no idempotency key / inbox / retry — a missed delivery self-heals on the next visit. WISPACE should debounce (≈1 ping / learner / 5–15 min), not send per pageview.
- Gate: `WEB_ACTIVITY_GATE_ENABLED` (default `false`), `WEB_ACTIVITY_DORMANT_DAYS` (default `7`). When enabled, study-reminder dispatch cancels a dormant recipient's claimed job with reason `recipient dormant (web inactivity)`, and each bot's daily report cron skips the LLM call for dormant learners. Fail-open: no row or DB error → not dormant. User-initiated chat is never gated. Skipped reminders are not backfilled.
- Metrics: `<bot>_web_activity_webhook_received_total`, `<bot>_scheduled_send_suppressed_total{feature="report"|"reminder"}`.
- Privacy: `web_activity` rows are deleted by `PrivacyDataService.delete()` (userId-scoped). A row can be orphaned if the erased mapping had no `userId`, or re-created if WISPACE keeps pinging a since-erased learner — inert (the gate only reads userIds from active mappings), no cleanup cron.

- [ ] **Step 2: `.claude/rules/database.md`**

- Add to the Tables list: `` - `web_activity` — one row per WISPACE `userId`, `last_active_at` merged with `GREATEST`; drives the scheduled-send dormancy gate. Self-updating, no cleanup cron; erased by `PrivacyDataService.delete()` (userId-scoped, orphan row kept when mapping has no userId). ``
- Add a row to the "Ownership of existing migrations" table: `` Cross-platform (generalized) | `1786934000000-CreateWebActivityTable` | `web_activity` ``

- [ ] **Step 3: `.env.shared.example`**

Add to the Vault-stored variable list comment: `WEB_ACTIVITY_GATE_ENABLED, WEB_ACTIVITY_DORMANT_DAYS`.

- [ ] **Step 4: `docs/wispace-integration-guide.md`**

Add the webhook contract (method/path/auth/body/semantics/debounce) as above, from WISPACE's perspective.

- [ ] **Step 5: Commit**

```bash
git add docs/project-overview.md .claude/rules/database.md .env.shared.example docs/wispace-integration-guide.md
git commit -m "docs: document web-activity dormancy gate + webhook contract"
```

---

## Final verification

- [ ] **Step 1: Full quality gate**

```bash
npx turbo run lint test build \
  --filter=@wispace/messenger-bot... --filter=@wispace/discord-bot... --filter=@wispace/zalo-bot... \
  --filter=@wispace/database --filter=@wispace/study-reminder-shared --filter=@wispace/bot-metrics
```
Expected: all PASS.

- [ ] **Step 2: DB compatibility (repo root, `NODE_ENV=test`, loopback `DB_HOST`)**

```bash
npm run database:migration-compatibility
npm run database:entity-discovery:test
bash .github/scripts/check-migration-timestamps.sh packages/database/src/migrations
```
Expected: all PASS.

- [ ] **Step 3: Manual smoke (optional, local DB)**

```bash
# gate off (default): reminders + reports behave exactly as before, no web_activity query
# gate on:
#   psql> INSERT INTO web_activity(user_id,last_active_at,updated_at) VALUES (<linked userId>, now() - interval '10 days', now());
#   POST /messenger/send-study-reminders  -> that user's due job is cancelled with reason 'recipient dormant (web inactivity)'
#   POST /messenger/send-reports          -> that user is skipped
#   POST /messenger/wispace/web-activity {"userId": <same>}  -> row refreshed, next run sends normally
```

---

## Self-Review

**Spec coverage** — every acceptance criterion in issue #595 maps to a task:

| Acceptance criterion | Task(s) |
| --- | --- |
| Endpoint accepts `{ userId, activeAt? }`, rejects unauthenticated + non-positive `userId`, clamps future `activeAt`, `GREATEST` upsert; test covers insert / later-timestamp / stale no-op | 1, 2, 5 |
| Entity + migration in `packages/database`, registered by all three apps; compat check green | 1, 3 |
| `filterDormant` returns only stale-row userIds; no-row and DB-error → not dormant; gate-disabled path; test covers has-row-stale / has-row-fresh / no-row / disabled | 2 |
| Gate on → dormant reminder cancelled with the exact reason, dormant daily report skips the LLM call, non-dormant unaffected; test covers dormant vs active | 6, 7, 8, 9, 10 |
| `WEB_ACTIVITY_GATE_ENABLED=false` → no dormancy query, every send path unchanged; test asserts gate not consulted | 2 (early-return), 6, 8–10 (`gateEnabled` guard) |
| User-initiated chat never gated | — (no chat-path change anywhere in this plan; call out in PR description) |
| `web_activity` rows removed by existing privacy erasure; test covers it | 11 |
| Metrics: webhook receipts + suppressed sends split by feature | 4, 5, 7, 8–10 |
| Format / lint / typecheck / test / build green across affected apps + packages | Final verification |

**Placeholder scan:** no `TBD` / "add validation" / "handle edge cases" — every code step carries the actual snippet or an exact edit location.

**Type consistency:** `filterDormant(userIds: number[]): Promise<number[]>` — same signature in Task 2 (impl), Task 6 (`filterDormantUserIds` option calls it), Task 7 (`dormancyGate` structural type), Tasks 8–10 (cron call sites). Cancellation reason string `'recipient dormant (web inactivity)'` — identical in Task 2 (`DORMANT_REASON` export, unused cross-package), Task 6 (local `DORMANT_REASON` const + `markCancelled` + `onCancelled`), Task 7 (`ctx.reason ===` comparisons in all three apps). `onCancelled` payload `{ jobId, externalUserId, reason }` — defined in Task 6 (port), consumed in Task 7 (all three hook impls). `incScheduledSendSuppressed(feature: 'report' | 'reminder')` — defined Task 4, called Task 7 (reminder) + Tasks 8–10 (report).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-08-29-web-activity-dormancy-gate.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
