# Security Hardening Implementation Plan (#277, #262, #264, #281)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden security across 4 areas: DB port exposure, PII at rest, OAuth CSRF, and deploy privileges.

**Architecture:** Four independent fixes. #277 and #281 are doc/config changes. #262 is a single migration. #264 mirrors the existing Zalo OAuth state pattern for Discord.

**Tech Stack:** TypeORM, PostgreSQL, NestJS, Jest, bash.

## Global Constraints

- Follow existing Zalo OAuth state pattern for #264: `randomBytes(24)` state, server-side store, 10min TTL, single-use.
- Migrations go in `packages/database/src/migrations/`.
- Entities go in the owning bot's `infrastructure/database/entities/` for bot-specific, or `packages/database/src/entities/` for shared.
- Tests use Jest, match existing patterns in each package.
- No comments unless asked.

---

### Task 1: #277 — Explicit localhost bindings + docs

**Files:**
- Modify: `deploy/monitoring/docker-compose.yml`
- Modify: `docs/project-overview.md`

**Interfaces:**
- Produces: defense-in-depth port binding documentation.

- [ ] **Step 1: Add explicit localhost binding to postgres in monitoring docker-compose**

In `deploy/monitoring/docker-compose.yml`, if any service exposes a postgres port, ensure it's bound to `127.0.0.1:`. If no postgres port is exposed (current state), add a comment documenting the policy.

- [ ] **Step 2: Add DB port exposure policy to docs**

In `docs/project-overview.md`, add a note under the Security section:

```markdown
**DB port exposure:** PostgreSQL must never be published to `0.0.0.0`. All docker-compose files and `docker run` commands must bind DB ports to `127.0.0.1` only. Public exposure is a P1 security incident.
```

- [ ] **Step 3: Commit**

```bash
git add deploy/monitoring/docker-compose.yml docs/project-overview.md
git commit -m "docs(security): add explicit localhost DB port binding policy (#277)"
```

---

### Task 2: #262 — Drop message_text from message_logs

**Files:**
- Create: `packages/database/src/migrations/20260821000001-DropMessageLogsMessageTextColumn.ts`

**Interfaces:**
- Produces: migration that drops `message_text` from `message_logs`.

- [ ] **Step 1: Create the migration**

Create `packages/database/src/migrations/20260821000001-DropMessageLogsMessageTextColumn.ts`:

```typescript
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 2 of #262: Drop message_text column from message_logs.
 * The column was null'd in migration 1786915000000 and is never written to
 * by application code. The entity has no message_text field.
 */
export class DropMessageLogsMessageTextColumn20260821000001
  implements MigrationInterface {
  name = 'DropMessageLogsMessageTextColumn20260821000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasColumn = await queryRunner.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'message_logs' AND column_name = 'message_text')`,
    );
    if (hasColumn[0]?.exists) {
      await queryRunner.query(
        `ALTER TABLE "message_logs" DROP COLUMN "message_text"`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const hasColumn = await queryRunner.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'message_logs' AND column_name = 'message_text')`,
    );
    if (!hasColumn[0]?.exists) {
      await queryRunner.query(
        `ALTER TABLE "message_logs" ADD COLUMN "message_text" text`,
      );
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/database/src/migrations/20260821000001-DropMessageLogsMessageTextColumn.ts
git commit -m "feat(db): drop message_text column from message_logs (#262)"
```

---

### Task 3: #264 — Discord OAuth state entity + migration

**Files:**
- Create: `apps/discord-bot/src/infrastructure/database/entities/discord-oauth-state.entity.ts`
- Create: `packages/database/src/migrations/20260821000002-CreateDiscordOauthStatesTable.ts`

**Interfaces:**
- Produces: `DiscordOauthStateEntity` with fields `state` (PK), `linkToken`, `createdAt`.

- [ ] **Step 1: Create the entity**

Create `apps/discord-bot/src/infrastructure/database/entities/discord-oauth-state.entity.ts`:

```typescript
import { Column, CreateDateColumn, Entity, Index } from 'typeorm';

/**
 * Server-side OAuth state for Discord link CSRF protection (#264).
 * Mirrors zalo_oauth_states: random state → link token mapping,
 * single-use, 10min TTL enforced in app code.
 */
@Entity('discord_oauth_states')
@Index('idx_discord_oauth_state_created', ['createdAt'])
export class DiscordOauthStateEntity {
  @Column({ name: 'state', type: 'varchar', length: 64, primary: true })
  state: string;

  @Column({ name: 'link_token', type: 'varchar', length: 512 })
  linkToken: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
```

- [ ] **Step 2: Create the migration**

Create `packages/database/src/migrations/20260821000002-CreateDiscordOauthStatesTable.ts`:

```typescript
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateDiscordOauthStatesTable20260821000002
  implements MigrationInterface {
  name = 'CreateDiscordOauthStatesTable20260821000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "discord_oauth_states" (
        "state" varchar(64) PRIMARY KEY,
        "link_token" varchar(512) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_discord_oauth_state_created"
      ON "discord_oauth_states" ("created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "discord_oauth_states"`);
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/discord-bot/src/infrastructure/database/entities/discord-oauth-state.entity.ts packages/database/src/migrations/20260821000002-CreateDiscordOauthStatesTable.ts
git commit -m "feat(db): add discord_oauth_states table for CSRF state binding (#264)"
```

---

### Task 4: #264 — Discord OAuth state service

**Files:**
- Create: `apps/discord-bot/src/modules/account-link/application/services/discord-oauth-state.service.ts`
- Create: `apps/discord-bot/src/modules/account-link/application/services/discord-oauth-state.service.spec.ts`

**Interfaces:**
- Consumes: `DiscordOauthStateEntity` (from Task 3).
- Produces: `DiscordOauthStateService.create(state) → string`, `DiscordOauthStateService.consume(state) → { linkToken } | undefined`.

- [ ] **Step 1: Write the failing test**

Create `apps/discord-bot/src/modules/account-link/application/services/discord-oauth-state.service.spec.ts`:

```typescript
import { DiscordOauthStateService } from './discord-oauth-state.service';

function mockRepo() {
  return {
    save: jest.fn(),
    query: jest.fn().mockResolvedValue([]),
  };
}

describe('DiscordOauthStateService', () => {
  describe('create', () => {
    it('generates a random state and saves it with the link token', async () => {
      const repo = mockRepo();
      const service = new DiscordOauthStateService(repo as never);

      const state = await service.create('link-token-123');

      expect(typeof state).toBe('string');
      expect(state.length).toBe(48); // 24 bytes hex
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.any(String),
          linkToken: 'link-token-123',
        }),
      );
    });
  });

  describe('consume', () => {
    it('returns linkToken when state exists and is fresh', async () => {
      const repo = mockRepo();
      const now = new Date();
      repo.query.mockResolvedValue([
        { link_token: 'link-token-123', created_at: now },
      ]);
      const service = new DiscordOauthStateService(repo as never);

      const result = await service.consume('some-state');
      expect(result).toEqual({ linkToken: 'link-token-123' });
    });

    it('returns undefined when state does not exist', async () => {
      const repo = mockRepo();
      repo.query.mockResolvedValue([]);
      const service = new DiscordOauthStateService(repo as never);

      const result = await service.consume('unknown-state');
      expect(result).toBeUndefined();
    });

    it('returns undefined when state is expired (>10min)', async () => {
      const repo = mockRepo();
      const old = new Date(Date.now() - 11 * 60 * 1000);
      repo.query.mockResolvedValue([
        { link_token: 'link-token-123', created_at: old },
      ]);
      const service = new DiscordOauthStateService(repo as never);

      const result = await service.consume('some-state');
      expect(result).toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/account-link/application/services/discord-oauth-state.service.spec.ts --no-coverage`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the service**

Create `apps/discord-bot/src/modules/account-link/application/services/discord-oauth-state.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { Repository } from 'typeorm';
import { DiscordOauthStateEntity } from '../../../../infrastructure/database/entities/discord-oauth-state.entity';

const STATE_TTL_MS = 10 * 60_000;

@Injectable()
export class DiscordOauthStateService {
  constructor(
    @InjectRepository(DiscordOauthStateEntity)
    private readonly repo: Repository<DiscordOauthStateEntity>,
  ) {}

  async create(linkToken: string): Promise<string> {
    const state = randomBytes(24).toString('hex');
    await this.repo.save(
      this.repo.create({ state, linkToken, createdAt: new Date() }),
    );
    return state;
  }

  async consume(
    state: string,
  ): Promise<{ linkToken: string } | undefined> {
    const rows = await this.repo.query<
      Array<{ link_token: string; created_at: Date }>
    >(
      `DELETE FROM "discord_oauth_states"
       WHERE "state" = $1
       RETURNING "link_token", "created_at"`,
      [state],
    );
    const row = rows[0];
    if (!row) return undefined;

    const isExpired =
      Date.now() - new Date(row.created_at).getTime() > STATE_TTL_MS;
    return isExpired ? undefined : { linkToken: row.link_token };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/account-link/application/services/discord-oauth-state.service.spec.ts --no-coverage`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/discord-bot/src/modules/account-link/application/services/discord-oauth-state.service.ts apps/discord-bot/src/modules/account-link/application/services/discord-oauth-state.service.spec.ts
git commit -m "feat(discord): add OAuth state service for CSRF protection (#264)"
```

---

### Task 5: #264 — Wire state binding into controller + module

**Files:**
- Modify: `apps/discord-bot/src/modules/account-link/presentation/controllers/discord-oauth.controller.ts`
- Modify: `apps/discord-bot/src/modules/account-link/account-link.module.ts`
- Create: `apps/discord-bot/src/modules/account-link/presentation/controllers/discord-oauth.controller.spec.ts`

**Interfaces:**
- Consumes: `DiscordOauthStateService` (from Task 4).
- Produces: controller uses state binding for `/url` and `/callback`.

- [ ] **Step 1: Write the failing test**

Create `apps/discord-bot/src/modules/account-link/presentation/controllers/discord-oauth.controller.spec.ts`:

```typescript
import { DiscordOauthController } from './discord-oauth.controller';

function mockDeps() {
  return {
    configService: {
      getOrThrow: jest.fn((key: string) => {
        const vars: Record<string, string> = {
          DISCORD_CLIENT_ID: 'client-id',
          DISCORD_OAUTH_REDIRECT_URI: 'https://bot.example.com/discord/oauth/callback',
          DISCORD_LINK_LANDING_URL: 'https://landing.example.com',
        };
        return vars[key];
      }),
      get: jest.fn(),
    },
    completionService: { completeLink: jest.fn() },
    stateService: { create: jest.fn(), consume: jest.fn() },
  };
}

describe('DiscordOauthController', () => {
  describe('getOAuthUrl', () => {
    it('generates a state and includes it in the OAuth URL', async () => {
      const deps = mockDeps();
      deps.stateService.create.mockResolvedValue('random-state-123');
      const controller = new DiscordOauthController(
        deps.configService as never,
        deps.completionService as never,
        deps.stateService as never,
      );

      const res = { json: jest.fn() } as never;
      await controller.getOAuthUrl(undefined, 'link-token-abc', res);

      expect(deps.stateService.create).toHaveBeenCalledWith('link-token-abc');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining('state=random-state-123'),
        }),
      );
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/account-link/presentation/controllers/discord-oauth.controller.spec.ts --no-coverage`
Expected: FAIL — controller signature doesn't match.

- [ ] **Step 3: Update the controller**

Modify `apps/discord-bot/src/modules/account-link/presentation/controllers/discord-oauth.controller.ts`:

**a) Add `DiscordOauthStateService` to constructor:**

```typescript
constructor(
  private readonly configService: ConfigService,
  private readonly completionService: DiscordLinkCompletionService,
  private readonly stateService: DiscordOauthStateService,
) {}
```

**b) Update `getOAuthUrl` to accept `linkToken` and generate state:**

```typescript
@Get('url')
async getOAuthUrl(
  @Query('state') linkToken: string | undefined,
  @Res() res: Response,
): Promise<void> {
  const clientId = this.configService.getOrThrow<string>('DISCORD_CLIENT_ID');
  const redirectUri = this.configService.getOrThrow<string>(
    'DISCORD_OAUTH_REDIRECT_URI',
  );

  if (!linkToken?.trim()) {
    res.json({ url: '' });
    return;
  }

  const state = await this.stateService.create(linkToken.trim());

  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'identify');
  url.searchParams.set('state', state);

  res.json({ url: url.toString() });
}
```

**c) Update `callback` to consume state before completing link:**

```typescript
@Get('callback')
async callback(
  @Query('code') code: string | undefined,
  @Query('state') state: string | undefined,
  @Query('error') discordError: string | undefined,
  @Res() res: Response,
): Promise<void> {
  if (discordError === 'access_denied') {
    this.sendResult(res, 'cancelled');
    return;
  }
  if (!code || !state) {
    this.sendResult(res, 'error');
    return;
  }

  const consumed = await this.stateService.consume(state);
  if (!consumed) {
    this.logger.warn('Discord OAuth callback: invalid or expired state');
    this.sendResult(res, 'error');
    return;
  }

  try {
    const outcome = await this.completionService.completeLink(
      code,
      consumed.linkToken,
    );
    this.sendResult(res, outcome === 'success' ? 'success' : 'not-in-guild');
  } catch (error) {
    this.logger.error(
      `Discord OAuth callback failed: ${errorMessage(error)}`,
    );
    this.sendResult(res, 'error');
  }
}
```

- [ ] **Step 4: Add import for DiscordOauthStateService**

At the top of the controller file, add:

```typescript
import { DiscordOauthStateService } from '../../application/services/discord-oauth-state.service';
```

- [ ] **Step 5: Wire entity + service into module**

In `apps/discord-bot/src/modules/account-link/account-link.module.ts`:

1. Add `DiscordOauthStateEntity` to the `TypeOrmModule.forFeature([...])` array.
2. Add `DiscordOauthStateService` to the `providers` array.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest src/modules/account-link/ --no-coverage`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add apps/discord-bot/src/modules/account-link/
git commit -m "feat(discord): wire OAuth state binding into controller and module (#264)"
```

---

### Task 6: #281 — Reject uid 0 in deploy script

**Files:**
- Modify: `.github/scripts/vps-deploy.sh`

**Interfaces:**
- Produces: deploy script fails if DEPLOY_UID is 0.

- [ ] **Step 1: Add uid 0 guard**

In `.github/scripts/vps-deploy.sh`, after the `ensure_env_var DEPLOY_UID` line, add:

```bash
# Reject running containers as root (#281)
if [ "$DEPLOY_UID" = "0" ]; then
  echo "ERROR: DEPLOY_UID=0 is not allowed — containers must not run as root" >&2
  exit 1
fi
```

- [ ] **Step 2: Add deploy privilege docs**

In `docs/project-overview.md`, add under Security:

```markdown
**Deploy privileges:** The deploy identity must not have root access. `DEPLOY_UID` must never be 0. Nginx reload should be restricted to the deploy user via sudoers: `deploy ALL=(root) NOPASSWD: /usr/sbin/nginx -s reload` only.
```

- [ ] **Step 3: Commit**

```bash
git add .github/scripts/vps-deploy.sh docs/project-overview.md
git commit -m "fix(deploy): reject uid 0 and document deploy privilege restrictions (#281)"
```
