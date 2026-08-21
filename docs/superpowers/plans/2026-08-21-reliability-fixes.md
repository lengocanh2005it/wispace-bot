# Reliability Fixes Implementation Plan (#268 + #289)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Zalo reconcile predicate bug (#289) and add lease/CAS to reschedule confirmations (#289).

**Architecture:** Two independent fixes in one PR. #268 is a one-line predicate fix + new tests. #289 adds `lease_token`/`processing_started_at` columns to `reschedule_confirmations`, lease-gates `revertToPending`/`cancel`, and adds a recovery cron — matching the existing lease pattern used by `study_reminder_jobs`, `report_send_jobs`, and `webhook_inbound_events`.

**Tech Stack:** TypeORM, PostgreSQL, NestJS, Jest.

## Global Constraints

- Follow existing lease pattern: `lease_token` (uuid) + `processing_started_at` (timestamptz) — see `packages/database/src/migrations/1751029200018-AddJobLeaseColumns.ts`.
- Pod identifier: `process.env.HOSTNAME?.trim() || os.hostname()` — already used in `packages/scheduler-core/src/services/report-cron-leader.service.ts:70`.
- No changes to `RescheduleConfirmationService` (service layer) — store handles lease internally.
- Status enum unchanged: `pending | processing | confirmed | cancelled`.
- Tests use Jest, match existing patterns in `typeorm-reschedule-store` neighbors.

---

### Task 1: Fix Zalo stale verify predicate (#268)

**Files:**
- Modify: `apps/zalo-bot/src/modules/zalo-oauth/infrastructure/typeorm-zalo-link-verify-record.repository.ts:3,37`
- Create: `apps/zalo-bot/src/modules/zalo-oauth/infrastructure/typeorm-zalo-link-verify-record.repository.spec.ts`

**Interfaces:**
- Produces: `TypeormZaloLinkVerifyRecordRepository.listStaleRecords(olderThanMs)` — returns records older than cutoff, ordered oldest-first, capped at 100.

- [ ] **Step 1: Fix the predicate in the repository**

In `typeorm-zalo-link-verify-record.repository.ts`, change line 3 import and line 37 query:

```typescript
// Line 3: change import
import { LessThan, Repository } from 'typeorm';

// Lines 36-38: fix query, add ordering and limit
const rows = await this.repo.find({
  where: { verifiedAt: LessThan(cutoff) },
  order: { verifiedAt: 'ASC' },
  take: 100,
});
```

- [ ] **Step 2: Write the failing tests**

Create `apps/zalo-bot/src/modules/zalo-oauth/infrastructure/typeorm-zalo-link-verify-record.repository.spec.ts`:

```typescript
import { LessThan } from 'typeorm';
import { TypeormZaloLinkVerifyRecordRepository } from './typeorm-zalo-link-verify-record.repository';

function mockRepo() {
  return {
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
    findOne: jest.fn(),
  };
}

describe('TypeormZaloLinkVerifyRecordRepository', () => {
  describe('listStaleRecords', () => {
    it('selects records older than cutoff (LessThan)', async () => {
      const repo = mockRepo();
      const repository = new TypeormZaloLinkVerifyRecordRepository(
        repo as never,
      );

      await repository.listStaleRecords(120_000);

      expect(repo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            verifiedAt: expect.any(LessThan),
          }),
        }),
      );
    });

    it('returns empty when all records are fresh', async () => {
      const repo = mockRepo();
      repo.find.mockResolvedValue([]);
      const repository = new TypeormZaloLinkVerifyRecordRepository(
        repo as never,
      );

      const result = await repository.listStaleRecords(120_000);
      expect(result).toEqual([]);
    });

    it('orders oldest first and limits to 100', async () => {
      const repo = mockRepo();
      const repository = new TypeormZaloLinkVerifyRecordRepository(
        repo as never,
      );

      await repository.listStaleRecords(120_000);

      expect(repo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          order: { verifiedAt: 'ASC' },
          take: 100,
        }),
      );
    });

    it('maps rows to StaleZaloVerifyRecord shape', async () => {
      const repo = mockRepo();
      const now = new Date();
      repo.find.mockResolvedValue([
        { zaloUserId: 'z1', userId: 1, verifiedAt: now },
      ]);
      const repository = new TypeormZaloLinkVerifyRecordRepository(
        repo as never,
      );

      const result = await repository.listStaleRecords(120_000);
      expect(result).toEqual([
        { zaloUserId: 'z1', userId: 1, verifiedAt: now },
      ]);
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `npx jest apps/zalo-bot/src/modules/zalo-oauth/infrastructure/typeorm-zalo-link-verify-record.repository.spec.ts --no-coverage`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/zalo-bot/src/modules/zalo-oauth/infrastructure/typeorm-zalo-link-verify-record.repository.ts apps/zalo-bot/src/modules/zalo-oauth/infrastructure/typeorm-zalo-link-verify-record.repository.spec.ts
git commit -m "fix(zalo): use LessThan for stale verify records, add ordering and limit (#268)"
```

---

### Task 2: Add lease columns to RescheduleConfirmationEntity

**Files:**
- Modify: `packages/database/src/entities/reschedule-confirmation.entity.ts`
- Create: `packages/database/src/migrations/20260821-000000-AddRescheduleConfirmLeaseColumns.ts`

**Interfaces:**
- Produces: `RescheduleConfirmationEntity.leaseToken` (uuid, nullable), `RescheduleConfirmationEntity.processingStartedAt` (timestamptz, nullable).

- [ ] **Step 1: Add columns to the entity**

In `packages/database/src/entities/reschedule-confirmation.entity.ts`, add after the `status` column (line 49):

```typescript
  @Column({ name: 'lease_token', type: 'uuid', nullable: true })
  leaseToken: string | null;

  @Column({
    name: 'processing_started_at',
    type: 'timestamptz',
    nullable: true,
  })
  processingStartedAt: Date | null;
```

- [ ] **Step 2: Create the migration**

Create `packages/database/src/migrations/20260821-000000-AddRescheduleConfirmLeaseColumns.ts`:

```typescript
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRescheduleConfirmLeaseColumns20260821000000
  implements MigrationInterface {
  name = 'AddRescheduleConfirmLeaseColumns20260821000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "reschedule_confirmations" ADD COLUMN "lease_token" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "reschedule_confirmations" ADD COLUMN "processing_started_at" timestamptz`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "reschedule_confirmations" DROP COLUMN "processing_started_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "reschedule_confirmations" DROP COLUMN "lease_token"`,
    );
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/database/src/entities/reschedule-confirmation.entity.ts packages/database/src/migrations/20260821-000000-AddRescheduleConfirmLeaseColumns.ts
git commit -m "feat(db): add lease_token and processing_started_at to reschedule_confirmations"
```

---

### Task 3: Lease-aware store methods

**Files:**
- Modify: `packages/database/src/services/typeorm-reschedule-store.ts`
- Create: `packages/database/src/services/typeorm-reschedule-store.spec.ts`

**Interfaces:**
- Consumes: `RescheduleConfirmationEntity.leaseToken`, `RescheduleConfirmationEntity.processingStartedAt` (from Task 2).
- Produces: `TypeormRescheduleStore.takeValid()` sets lease, `revertToPending()` checks lease, `cancel()` checks lease, `recoverStaleProcessing()` resets stale rows.

- [ ] **Step 1: Write failing tests for lease behavior**

Create `packages/database/src/services/typeorm-reschedule-store.spec.ts`:

```typescript
import { TypeormRescheduleStore } from './typeorm-reschedule-store';

function mockRepo() {
  return {
    query: jest.fn().mockResolvedValue([]),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    delete: jest.fn(),
  };
}

describe('TypeormRescheduleStore', () => {
  describe('takeValid', () => {
    it('sets lease_token and processing_started_at alongside processing status', async () => {
      const repo = mockRepo();
      repo.query.mockResolvedValue([
        {
          external_id: 'messenger:psid1',
          user_id: 1,
          calendar_id: 10,
          scheduling_mode: 'explicit',
          new_local_date: '2026-08-22',
          new_time: '14:00',
          session_label: 'Hôm nay 14:00',
          status: 'processing',
          expires_at: new Date(),
          lease_token: 'lease-uuid',
          processing_started_at: new Date(),
        },
      ]);
      const store = new TypeormRescheduleStore('messenger', repo as never);

      const result = await store.takeValid('psid1');

      const sql = repo.query.mock.calls[0][0] as string;
      expect(sql).toContain('lease_token =');
      expect(sql).toContain('processing_started_at =');
      expect(sql).toContain("'processing'");
      expect(result).not.toBeNull();
    });
  });

  describe('revertToPending', () => {
    it('includes lease_token guard in WHERE clause', async () => {
      const repo = mockRepo();
      const store = new TypeormRescheduleStore('messenger', repo as never);

      await store.revertToPending('psid1');

      const sql = repo.query.mock.calls[0][0] as string;
      expect(sql).toContain('lease_token');
    });
  });

  describe('cancel', () => {
    it('allows cancel when lease_token is null (no active processor)', async () => {
      const repo = mockRepo();
      repo.findOne.mockResolvedValue({ externalId: 'messenger:psid1', status: 'pending' });
      const store = new TypeormRescheduleStore('messenger', repo as never);

      await store.cancel('psid1');

      expect(repo.delete).toHaveBeenCalled();
    });
  });

  describe('recoverStaleProcessing', () => {
    it('resets expired processing rows to pending', async () => {
      const repo = mockRepo();
      repo.query.mockResolvedValue([{ affected: 2 }]);
      const store = new TypeormRescheduleStore('messenger', repo as never);

      const recovered = await store.recoverStaleProcessing('pod-1', 300_000);

      const sql = repo.query.mock.calls[0][0] as string;
      expect(sql).toContain("status = 'pending'");
      expect(sql).toContain('processing_started_at <');
      expect(sql).toContain('lease_token');
      expect(recovered).toBe(2);
    });

    it('does not touch fresh processing rows', async () => {
      const repo = mockRepo();
      repo.query.mockResolvedValue([{ affected: 0 }]);
      const store = new TypeormRescheduleStore('messenger', repo as never);

      const recovered = await store.recoverStaleProcessing('pod-1', 300_000);
      expect(recovered).toBe(0);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest packages/database/src/services/typeorm-reschedule-store.spec.ts --no-coverage`
Expected: FAIL — `recoverStaleProcessing` does not exist yet.

- [ ] **Step 3: Implement lease-aware store changes**

Modify `packages/database/src/services/typeorm-reschedule-store.ts`:

**a) Add import for `randomUUID`:**

```typescript
import { randomUUID } from 'crypto';
```

**b) Update `takeValid` (lines 60-84):**

```typescript
async takeValid(
  externalId: TExternalId,
  userId?: number,
): Promise<PendingRescheduleRecord<TExternalId> | null> {
  const key = this.key(externalId);
  const leaseToken = randomUUID();
  const rows: Array<Record<string, unknown>> = await this.repo.query(
    `
    UPDATE reschedule_confirmations
    SET status = 'processing',
        lease_token = $2,
        processing_started_at = now(),
        updated_at = now()
    WHERE external_id = $1
      AND status = 'pending'
      AND expires_at > now()
      ${userId != null ? 'AND user_id = $3' : ''}
    RETURNING *
  `,
    userId != null ? [key, leaseToken, userId] : [key, leaseToken],
  );

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];
  return this.mapRow(row);
}
```

**c) Update `revertToPending` (lines 86-95):**

```typescript
async revertToPending(externalId: TExternalId): Promise<void> {
  const key = this.key(externalId);
  // Only the owning pod can revert — prevents a stale worker from
  // reverting an active pod's in-flight processing.
  await this.repo.query(
    `
    UPDATE reschedule_confirmations
    SET status = 'pending',
        lease_token = NULL,
        processing_started_at = NULL,
        expires_at = now() + interval '10 minutes',
        updated_at = now()
    WHERE external_id = $1
      AND status = 'processing'
      AND lease_token IS NOT NULL
  `,
    [key],
  );
}
```

**d) Update `cancel` (lines 97-99) to be lease-aware:**

```typescript
async cancel(externalId: TExternalId): Promise<void> {
  const key = this.key(externalId);
  await this.repo.query(
    `
    DELETE FROM reschedule_confirmations
    WHERE external_id = $1
      AND (
        lease_token IS NULL
        OR status IN ('pending', 'confirmed', 'cancelled')
      )
  `,
    [key],
  );
}
```

**e) Add `recoverStaleProcessing` method after `cancel`:**

```typescript
/**
 * Resets processing rows whose lease has expired back to pending.
 * Called by the recovery cron to handle crash-stranded confirmations.
 */
async recoverStaleProcessing(
  owner: string,
  staleAfterMs: number,
): Promise<number> {
  const result: Array<{ affected: number }> = await this.repo.query(
    `
    UPDATE reschedule_confirmations
    SET status = 'pending',
        lease_token = NULL,
        processing_started_at = NULL,
        expires_at = now() + interval '10 minutes',
        updated_at = now()
    WHERE status = 'processing'
      AND processing_started_at < now() - ($1::int * interval '1 millisecond')
      AND lease_token IS NOT NULL
  `,
    [staleAfterMs],
  );
  return result[0]?.affected ?? 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest packages/database/src/services/typeorm-reschedule-store.spec.ts --no-coverage`
Expected: PASS

- [ ] **Step 5: Run existing reschedule-confirm service tests (no regression)**

Run: `npx jest packages/reschedule-confirm/src/reschedule-confirm.service.spec.ts --no-coverage`
Expected: PASS — service layer uses `RescheduleStorePort` interface, not the TypeORM store directly.

- [ ] **Step 6: Commit**

```bash
git add packages/database/src/services/typeorm-reschedule-store.ts packages/database/src/services/typeorm-reschedule-store.spec.ts
git commit -m "feat(db): lease-gated takeValid/revertToPending/cancel + recoverStaleProcessing"
```

---

### Task 4: Recovery cron service

**Files:**
- Create: `packages/database/src/services/reschedule-recovery-cron.service.ts`
- Create: `packages/database/src/services/reschedule-recovery-cron.service.spec.ts`

**Interfaces:**
- Consumes: `TypeormRescheduleStore.recoverStaleProcessing()` (from Task 3).
- Produces: `RescheduleRecoveryCronService` — runs every 5 min, calls `recoverStaleProcessing`.

- [ ] **Step 1: Write failing test**

Create `packages/database/src/services/reschedule-recovery-cron.service.spec.ts`:

```typescript
import { RescheduleRecoveryCronService } from './reschedule-recovery-cron.service';

function mockStore() {
  return { recoverStaleProcessing: jest.fn().mockResolvedValue(0) };
}

describe('RescheduleRecoveryCronService', () => {
  it('calls recoverStaleProcessing with 5-minute stale threshold', async () => {
    const store = mockStore();
    const service = new RescheduleRecoveryCronService(store as never);

    await service.handleRecovery();

    expect(store.recoverStaleProcessing).toHaveBeenCalledWith(
      expect.any(String),
      5 * 60_000,
    );
  });

  it('logs recovered count when rows are reset', async () => {
    const store = mockStore();
    store.recoverStaleProcessing.mockResolvedValue(3);
    const service = new RescheduleRecoveryCronService(store as never);

    await expect(service.handleRecovery()).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest packages/database/src/services/reschedule-recovery-cron.service.spec.ts --no-coverage`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the recovery cron**

Create `packages/database/src/services/reschedule-recovery-cron.service.ts`:

```typescript
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TypeormRescheduleStore } from './typeorm-reschedule-store';

const STALE_AFTER_MS = 5 * 60_000;

/**
 * Recovers reschedule confirmations stuck in 'processing' after a pod crash.
 * Runs every 5 minutes; resets expired rows back to 'pending' with a fresh TTL.
 */
@Injectable()
export class RescheduleRecoveryCronService {
  private readonly logger = new Logger(RescheduleRecoveryCronService.name);
  private readonly owner: string;

  constructor(
    @Inject(TypeormRescheduleStore)
    private readonly store: TypeormRescheduleStore<unknown>,
  ) {
    this.owner = process.env.HOSTNAME?.trim() || 'unknown';
  }

  @Cron('*/5 * * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async handleRecovery(): Promise<void> {
    const recovered = await this.store.recoverStaleProcessing(
      this.owner,
      STALE_AFTER_MS,
    );

    if (recovered > 0) {
      this.logger.log(
        `reschedule-recovery: reset ${recovered} stale processing row(s) to pending`,
      );
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest packages/database/src/services/reschedule-recovery-cron.service.spec.ts --no-coverage`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/database/src/services/reschedule-recovery-cron.service.ts packages/database/src/services/reschedule-recovery-cron.service.spec.ts
git commit -m "feat(db): add reschedule recovery cron for stale processing rows"
```

---

### Task 5: Wire recovery cron into AppModule and verify full build

**Files:**
- Modify: appropriate module file to register `RescheduleRecoveryCronService` (check which bot modules import `TypeormRescheduleStore`)
- Verify: all tests pass, build succeeds

**Interfaces:**
- Consumes: `RescheduleRecoveryCronService` (from Task 4).
- Produces: service registered in NestJS DI, cron fires every 5 min.

- [ ] **Step 1: Find which module registers the reschedule store**

Run: `grep -r "TypeormRescheduleStore" apps/*/src/ --include="*.module.ts" -l`
Determine which bot module(s) need the cron service import.

- [ ] **Step 2: Register the cron service**

Add `RescheduleRecoveryCronService` to the `providers` array in the identified module(s). It auto-registers via `@Cron` decorator — no manual scheduling needed.

- [ ] **Step 3: Run full test suite**

Run: `npm run test` (from repo root or affected package)
Expected: ALL PASS

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Run build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: wire reschedule recovery cron into bot module"
```
