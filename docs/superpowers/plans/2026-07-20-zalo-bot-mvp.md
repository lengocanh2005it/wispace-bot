# Zalo Bot MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `apps/zalo-bot` (new NestJS app in the Turborepo monorepo) with a working MVP: webhook chat via the shared LLM agent, OA access-token lifecycle (auto-refresh), and Zalo Login account-linking to WISPACE — matching the scope locked in `docs/superpowers/specs/2026-07-20-zalo-bot-mvp-design.md`.

**Architecture:** NestJS HTTP app (`NestFactory.create`, not `createApplicationContext` — needs to expose both the webhook and the OAuth callback over HTTP), 4 feature modules (`zalo-webhook`, `zalo-chat`, `zalo-oauth`, `wispace` stub), each following the repo's 4-layer Clean Architecture convention. Reuses `@wispace/llm-agent` and `@wispace/chat-history` exactly as `apps/discord-bot` does. Migrations live in `apps/messenger-bot` (only that pipeline is allowed to run `migration:run` — see `.claude/rules/database.md`).

**Tech Stack:** NestJS 11, TypeORM, `@nestjs/config`, `@wispace/llm-agent`, `@wispace/chat-history`, `openai` (OpenAI-compatible provider adapter), Jest.

## Global Constraints

- No quota/rate-limit for this MVP — do **not** wire `packages/chat-metering` into `apps/zalo-bot` (spec §1, deferred to future work §11.3).
- No real WISPACE tool calls — `modules/wispace/` stays a stub returning `{ available: false, message: ... }` for every `AGENT_TOOLS` entry (spec §6).
- No debounce/merge — each webhook message is handled immediately (spec §4).
- Chat history is in-memory only via `@wispace/chat-history`'s `MemoryChatHistoryStore` — no Redis (spec §4).
- User-facing messages are Vietnamese; log/comment text is English or short Vietnamese (repo convention, `.claude/rules/project-conventions.md`).
- Do not add Redis/Bull/SQS. Do not touch `.env` files beyond adding new keys to `.env.example`/`.env.shared.example`. Do not commit/push unless asked (repo convention).
- Migration class/file naming: `Create<Platform><Feature>Table`, e.g. `CreateZaloAccountLinksTable` (`.claude/rules/database.md`).
- Follow the 4-layer dependency flow `presentation → application → domain ← infrastructure` inside `apps/zalo-bot/src/modules/*` (`.claude/rules/clean-architecture.md`).

---

## File Structure Overview

```
apps/zalo-bot/
├── package.json, nest-cli.json, tsconfig.json, tsconfig.build.json, .env.example
├── src/
│   ├── main.ts, app.module.ts, health.controller.ts (+ .spec.ts)
│   ├── infrastructure/database/
│   │   ├── database.module.ts
│   │   └── entities/
│   │       ├── zalo-oa-token.entity.ts
│   │       ├── zalo-oauth-state.entity.ts
│   │       └── zalo-account-link.entity.ts
│   ├── shared/prompts/zalo-chat.system.txt
│   └── modules/
│       ├── zalo-webhook/
│       │   ├── zalo-webhook.module.ts
│       │   ├── domain/entities/zalo-webhook-event.types.ts
│       │   ├── application/utils/zalo-webhook-signature.utils.ts (+ .spec.ts)
│       │   └── presentation/controllers/zalo-webhook.controller.ts (+ .spec.ts)
│       ├── zalo-oauth/
│       │   ├── zalo-oauth.module.ts
│       │   ├── application/services/zalo-token.service.ts (+ .spec.ts)
│       │   ├── application/services/zalo-token-refresh.service.ts (+ .spec.ts)
│       │   ├── application/services/zalo-oauth-state.service.ts (+ .spec.ts)
│       │   ├── application/services/zalo-account-link.service.ts (+ .spec.ts)
│       │   ├── infrastructure/wispace/wispace-zalo-token-verify.service.ts (+ .spec.ts)
│       │   └── presentation/controllers/zalo-oauth.controller.ts (+ .spec.ts)
│       ├── zalo-chat/
│       │   ├── zalo-chat.module.ts
│       │   ├── domain/entities/zalo-chat.types.ts
│       │   ├── application/agent/zalo-agent.service.ts
│       │   ├── application/agent/zalo-agent-tools.service.ts (+ .spec.ts)
│       │   ├── application/services/zalo-chat-history.service.ts (+ .spec.ts)
│       │   ├── application/services/zalo-outbound.service.ts (+ .spec.ts)
│       │   └── application/services/zalo-chat.service.ts (+ .spec.ts)
│       └── wispace/ (empty in this MVP — real tools are future work §11.1)
apps/messenger-bot/src/infrastructure/database/migrations/
├── 1751029200004-CreateZaloOaTokensTable.ts
├── 1751029200005-CreateZaloOauthStatesTable.ts
└── 1751029200006-CreateZaloAccountLinksTable.ts
```

---

### Task 1: Scaffold `apps/zalo-bot`

**Files:**
- Create: `apps/zalo-bot/package.json`
- Create: `apps/zalo-bot/nest-cli.json`
- Create: `apps/zalo-bot/tsconfig.json`
- Create: `apps/zalo-bot/tsconfig.build.json`
- Create: `apps/zalo-bot/.env.example`
- Create: `apps/zalo-bot/src/main.ts`
- Create: `apps/zalo-bot/src/app.module.ts`
- Create: `apps/zalo-bot/src/health.controller.ts`
- Test: `apps/zalo-bot/src/health.controller.spec.ts`
- Modify: `apps/zalo-bot/README.md` (replace placeholder content)

**Interfaces:**
- Produces: `AppModule` (NestJS root module, imports added incrementally by later tasks), `HealthController` (`GET /health`).

- [ ] **Step 1: Write the failing test for the health controller**

```typescript
// apps/zalo-bot/src/health.controller.spec.ts
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('returns status ok', () => {
    const controller = new HealthController();
    expect(controller.check()).toEqual({ status: 'ok' });
  });
});
```

- [ ] **Step 2: Create package.json (copies `apps/discord-bot/package.json` shape, no `discord.js`/`necord`)**

```json
{
  "name": "@wispace/zalo-bot",
  "version": "0.0.1",
  "description": "",
  "author": "",
  "private": true,
  "license": "UNLICENSED",
  "scripts": {
    "build": "nest build",
    "format": "prettier --cache --write \"src/**/*.ts\"",
    "start": "nest start",
    "start:dev": "nest start --watch",
    "start:dev:doppler": "doppler run -- npm run start:dev",
    "start:debug": "nest start --debug --watch",
    "start:prod": "node dist/main",
    "lint": "eslint \"{src,apps,libs}/**/*.ts\" --fix",
    "format:check": "prettier --check \"src/**/*.ts\"",
    "typecheck": "tsc -p tsconfig.build.json --noEmit",
    "verify": "npm run format:check && npm run lint && npm run typecheck && npm run test && npm run build",
    "test": "jest --runInBand --forceExit",
    "test:watch": "jest --watch",
    "test:cov": "jest --coverage"
  },
  "dependencies": {
    "@nestjs/common": "^11.0.1",
    "@nestjs/config": "^4.0.4",
    "@nestjs/core": "^11.0.1",
    "@nestjs/platform-express": "^11.0.1",
    "@nestjs/schedule": "^5.0.1",
    "@nestjs/typeorm": "^11.0.1",
    "@wispace/chat-history": "*",
    "@wispace/llm-agent": "*",
    "openai": "^6.42.0",
    "pg": "^8.21.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1",
    "typeorm": "^1.0.0"
  },
  "devDependencies": {
    "@eslint/eslintrc": "^3.2.0",
    "@eslint/js": "^9.18.0",
    "@nestjs/cli": "^11.0.0",
    "@nestjs/schematics": "^11.0.0",
    "@nestjs/testing": "^11.0.1",
    "@types/express": "^5.0.0",
    "@types/jest": "^30.0.0",
    "@types/node": "^24.0.0",
    "@types/pg": "^8.20.0",
    "eslint": "^9.18.0",
    "eslint-config-prettier": "^10.0.1",
    "eslint-plugin-prettier": "^5.2.2",
    "globals": "^17.0.0",
    "jest": "^30.0.0",
    "prettier": "^3.4.2",
    "source-map-support": "^0.5.21",
    "ts-jest": "^29.2.5",
    "ts-loader": "^9.5.2",
    "ts-node": "^10.9.2",
    "tsconfig-paths": "^4.2.0",
    "typescript": "^5.7.3",
    "typescript-eslint": "^8.20.0"
  },
  "jest": {
    "moduleFileExtensions": ["js", "json", "ts"],
    "rootDir": "src",
    "testRegex": ".*\\.spec\\.ts$",
    "transform": { "^.+\\.(t|j)s$": "ts-jest" },
    "collectCoverageFrom": ["**/*.(t|j)s"],
    "coverageDirectory": "../coverage",
    "testEnvironment": "node"
  }
}
```

- [ ] **Step 3: Create nest-cli.json, tsconfig.json, tsconfig.build.json (identical to `apps/discord-bot`'s, plus a prompts asset glob)**

```json
// apps/zalo-bot/nest-cli.json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true,
    "assets": ["shared/prompts/**/*"]
  }
}
```

```json
// apps/zalo-bot/tsconfig.json
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "resolvePackageJsonExports": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "declaration": true,
    "removeComments": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "allowSyntheticDefaultImports": true,
    "target": "ES2023",
    "sourceMap": true,
    "outDir": "./dist",
    "baseUrl": "./",
    "incremental": true,
    "skipLibCheck": true,
    "strictNullChecks": true,
    "forceConsistentCasingInFileNames": true,
    "noImplicitAny": true,
    "strictBindCallApply": true,
    "noFallthroughCasesInSwitch": false
  }
}
```

```json
// apps/zalo-bot/tsconfig.build.json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "test", "dist", "**/*spec.ts"]
}
```

- [ ] **Step 4: Create `main.ts`, `health.controller.ts`, minimal `app.module.ts`**

```typescript
// apps/zalo-bot/src/health.controller.ts
import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok' };
  }
}
```

```typescript
// apps/zalo-bot/src/main.ts
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors({ origin: '*' });
  await app.listen(process.env.PORT ?? 3002);
}
void bootstrap();
```

```typescript
// apps/zalo-bot/src/app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Own .env wins; falls back to root .env.shared for cross-bot vars
      // (WISPACE_INTERNAL_KEY, OPENAI_*, DB_*...) — see .env.shared.example.
      envFilePath: ['.env', '../../.env.shared'],
    }),
    ScheduleModule.forRoot(),
  ],
})
export class AppModule {}
```

**Note:** `DatabaseModule` and the feature modules are added to the `imports` array incrementally in Tasks 3, 8, 11 and 12 — do not wire them here, to keep this task's diff reviewable on its own.

- [ ] **Step 5: Create `.env.example`**

```bash
# apps/zalo-bot/.env.example
# Copy this to .env for local dev — platform-specific only. Biến dùng chung
# mọi bot (WISPACE_INTERNAL_KEY, OPENAI_*, DB_*...) nằm ở root .env.shared.example.
PORT=3002

# Zalo Official Account — app credentials (developers.zalo.me)
ZALO_APP_ID=replace-with-zalo-app-id
ZALO_APP_SECRET_KEY=replace-with-zalo-app-secret-key
# Webhook signature secret from OA Admin settings (khác ZALO_APP_SECRET_KEY)
ZALO_OA_SECRET_KEY=replace-with-oa-secret-key

# Zalo Login OAuth (account-linking) redirect — must match the app's configured redirect URI
ZALO_OAUTH_REDIRECT_URI=https://zalo-bot.example.com/zalo/oauth/callback

ZALO_CHAT_HISTORY_TTL_MS=1800000
ZALO_CHAT_HISTORY_MAX_MESSAGES=20
```

- [ ] **Step 6: Replace `apps/zalo-bot/README.md` placeholder content**

```markdown
# @wispace/zalo-bot

Zalo Official Account bot — chat qua `@wispace/llm-agent`, account-linking Zalo Login ↔ WISPACE userId, OA token lifecycle tự refresh.

Xem thiết kế đầy đủ ở [docs/superpowers/specs/2026-07-20-zalo-bot-mvp-design.md](../../docs/superpowers/specs/2026-07-20-zalo-bot-mvp-design.md) và kế hoạch triển khai ở [docs/superpowers/plans/2026-07-20-zalo-bot-mvp.md](../../docs/superpowers/plans/2026-07-20-zalo-bot-mvp.md).
```

- [ ] **Step 7: Install workspace deps and run the test**

Run: `npm install` (from repo root, so the new workspace resolves)
Run: `npx turbo run test --filter=@wispace/zalo-bot`
Expected: PASS — `HealthController` test green.

- [ ] **Step 8: Commit**

```bash
git add apps/zalo-bot package-lock.json
git commit -m "feat(zalo-bot): scaffold NestJS app skeleton"
```

---

### Task 2: DB migrations for the 3 new Zalo tables (in `apps/messenger-bot`)

**Files:**
- Create: `apps/messenger-bot/src/infrastructure/database/migrations/1751029200004-CreateZaloOaTokensTable.ts`
- Create: `apps/messenger-bot/src/infrastructure/database/migrations/1751029200005-CreateZaloOauthStatesTable.ts`
- Create: `apps/messenger-bot/src/infrastructure/database/migrations/1751029200006-CreateZaloAccountLinksTable.ts`

**Interfaces:**
- Produces: tables `zalo_oa_tokens`, `zalo_oauth_states`, `zalo_account_links` — consumed by Task 3's TypeORM entities in `apps/zalo-bot`.

Migrations are not unit-tested in this repo (no existing migration has a `.spec.ts` — verified via `npm run migration:run` against a real/staging DB). Follow `.claude/rules/database.md` naming convention and the exact shape of `1751029200002-CreateDiscordAccountLinksTable.ts`.

- [ ] **Step 1: Write `zalo_oa_tokens` migration (single-row OA token store, MVP has 1 OA — see spec §11.9 for multi-OA future work)**

```typescript
// apps/messenger-bot/src/infrastructure/database/migrations/1751029200004-CreateZaloOaTokensTable.ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Single-row store for the Zalo OA server-to-server access_token/refresh_token
 * pair (access_token: 1h, refresh_token: 30 days, single-use — see
 * docs/superpowers/specs/2026-07-20-zalo-bot-mvp-design.md §5.1). Only
 * `apps/messenger-bot` runs migrations (Phase 5 convention); only
 * `apps/zalo-bot` reads/writes this table.
 */
export class CreateZaloOaTokensTable1751029200004
  implements MigrationInterface
{
  name = 'CreateZaloOaTokensTable1751029200004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "zalo_oa_tokens" (
        "id"                       BIGSERIAL PRIMARY KEY,
        "access_token"             text NOT NULL,
        "refresh_token"            text NOT NULL,
        "access_token_expires_at"  TIMESTAMPTZ NOT NULL,
        "refresh_token_expires_at" TIMESTAMPTZ NOT NULL,
        "updated_at"               TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "zalo_oa_tokens"`);
  }
}
```

- [ ] **Step 2: Write `zalo_oauth_states` migration (PKCE `code_verifier` staging, TTL enforced by app query, not by schema)**

```typescript
// apps/messenger-bot/src/infrastructure/database/migrations/1751029200005-CreateZaloOauthStatesTable.ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PKCE code_verifier staging between GET /zalo/oauth/authorize and
 * GET /zalo/oauth/callback (Zalo Login requires PKCE, unlike Discord's
 * OAuth2 — see spec §5.2). TTL (10 min) is enforced by the app's query,
 * not a DB constraint — see ZaloOauthStateService (Task 8).
 */
export class CreateZaloOauthStatesTable1751029200005
  implements MigrationInterface
{
  name = 'CreateZaloOauthStatesTable1751029200005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "zalo_oauth_states" (
        "state"         character varying(64) PRIMARY KEY,
        "code_verifier" character varying(128) NOT NULL,
        "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "zalo_oauth_states"`);
  }
}
```

- [ ] **Step 3: Write `zalo_account_links` migration (same shape as `discord_account_links`, `platform` default `'zalo'`)**

```typescript
// apps/messenger-bot/src/infrastructure/database/migrations/1751029200006-CreateZaloAccountLinksTable.ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Zalo Login account-linking (Zalo userId ↔ WISPACE userId). Only
 * `apps/messenger-bot` runs migrations; only `apps/zalo-bot` reads/writes
 * this table (its own TypeOrmModule.forFeature).
 */
export class CreateZaloAccountLinksTable1751029200006
  implements MigrationInterface
{
  name = 'CreateZaloAccountLinksTable1751029200006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "zalo_account_links" (
        "id"               BIGSERIAL PRIMARY KEY,
        "platform"         character varying(16) NOT NULL DEFAULT 'zalo',
        "external_user_id" character varying(64) NOT NULL,
        "user_id"          integer NOT NULL,
        "linked_at"        TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_zalo_account_links_external_user_id"
        ON "zalo_account_links" ("platform", "external_user_id")
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_zalo_account_links_user_id"
        ON "zalo_account_links" ("platform", "user_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_zalo_account_links_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_zalo_account_links_external_user_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "zalo_account_links"`);
  }
}
```

- [ ] **Step 4: Run the migrations against your local/dev DB**

Run (from `apps/messenger-bot/`): `npm run migration:run`
Expected: output lists all 3 new migrations as executed, no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/messenger-bot/src/infrastructure/database/migrations/1751029200004-CreateZaloOaTokensTable.ts apps/messenger-bot/src/infrastructure/database/migrations/1751029200005-CreateZaloOauthStatesTable.ts apps/messenger-bot/src/infrastructure/database/migrations/1751029200006-CreateZaloAccountLinksTable.ts
git commit -m "feat(db): add zalo_oa_tokens, zalo_oauth_states, zalo_account_links tables"
```

---

### Task 3: Zalo entities + `DatabaseModule` in `apps/zalo-bot`

**Files:**
- Create: `apps/zalo-bot/src/infrastructure/database/entities/zalo-oa-token.entity.ts`
- Create: `apps/zalo-bot/src/infrastructure/database/entities/zalo-oauth-state.entity.ts`
- Create: `apps/zalo-bot/src/infrastructure/database/entities/zalo-account-link.entity.ts`
- Create: `apps/zalo-bot/src/infrastructure/database/database.module.ts`
- Modify: `apps/zalo-bot/src/app.module.ts` (add `DatabaseModule` to imports)

**Interfaces:**
- Consumes: tables created in Task 2.
- Produces: `ZaloOaTokenEntity`, `ZaloOauthStateEntity`, `ZaloAccountLinkEntity` (TypeORM entities) — consumed by Tasks 5–10's repositories.

No dedicated test for this task (pure TypeORM entity mapping + module wiring — mirrors `apps/discord-bot`'s `DatabaseModule`, which also has no spec). Verified by the build in Step 3.

- [ ] **Step 1: Create the 3 entities**

```typescript
// apps/zalo-bot/src/infrastructure/database/entities/zalo-oa-token.entity.ts
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Maps the `zalo_oa_tokens` table — see migration in apps/messenger-bot. */
@Entity('zalo_oa_tokens')
export class ZaloOaTokenEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ name: 'access_token', type: 'text' })
  accessToken: string;

  @Column({ name: 'refresh_token', type: 'text' })
  refreshToken: string;

  @Column({ name: 'access_token_expires_at', type: 'timestamptz' })
  accessTokenExpiresAt: Date;

  @Column({ name: 'refresh_token_expires_at', type: 'timestamptz' })
  refreshTokenExpiresAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
```

```typescript
// apps/zalo-bot/src/infrastructure/database/entities/zalo-oauth-state.entity.ts
import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Maps the `zalo_oauth_states` table — see migration in apps/messenger-bot. */
@Entity('zalo_oauth_states')
export class ZaloOauthStateEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  state: string;

  @Column({ name: 'code_verifier', type: 'varchar', length: 128 })
  codeVerifier: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
```

```typescript
// apps/zalo-bot/src/infrastructure/database/entities/zalo-account-link.entity.ts
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** Maps the `zalo_account_links` table — see migration in apps/messenger-bot. */
@Entity('zalo_account_links')
@Index('uq_zalo_account_links_external_user_id', ['platform', 'externalUserId'], {
  unique: true,
})
@Index('uq_zalo_account_links_user_id', ['platform', 'userId'], {
  unique: true,
})
export class ZaloAccountLinkEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'varchar', length: 16, default: 'zalo' })
  platform: string;

  @Column({ name: 'external_user_id', type: 'varchar', length: 64 })
  externalUserId: string;

  @Column({ name: 'user_id', type: 'int' })
  userId: number;

  @CreateDateColumn({ name: 'linked_at', type: 'timestamptz' })
  linkedAt: Date;
}
```

- [ ] **Step 2: Create `DatabaseModule`**

```typescript
// apps/zalo-bot/src/infrastructure/database/database.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSourceOptions } from 'typeorm';
import { ZaloOaTokenEntity } from './entities/zalo-oa-token.entity';
import { ZaloOauthStateEntity } from './entities/zalo-oauth-state.entity';
import { ZaloAccountLinkEntity } from './entities/zalo-account-link.entity';

/**
 * Connects to the same Postgres DB as `apps/messenger-bot` (Phase 2: shared
 * schema keyed by `(platform, external_user_id)`). Does NOT run/own
 * migrations — see `docs/turborepo-migration-plan.md` Phase 5: only
 * messenger-bot's pipeline is allowed to run `migration:run`.
 */
function buildTypeOrmOptions(config: ConfigService): DataSourceOptions {
  return {
    type: 'postgres',
    host: config.get<string>('DB_HOST'),
    port: Number(config.get<string>('DB_PORT') ?? 5432),
    username: config.get<string>('DB_USER'),
    password: config.get<string>('DB_PASSWORD'),
    database: config.get<string>('DB_NAME'),
    ssl:
      config.get<string>('DB_SSL') === 'true'
        ? { rejectUnauthorized: false }
        : false,
    entities: [ZaloOaTokenEntity, ZaloOauthStateEntity, ZaloAccountLinkEntity],
    synchronize: false,
    logging: config.get<string>('DB_LOGGING') === 'true',
  };
}

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: buildTypeOrmOptions,
    }),
    TypeOrmModule.forFeature([
      ZaloOaTokenEntity,
      ZaloOauthStateEntity,
      ZaloAccountLinkEntity,
    ]),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
```

- [ ] **Step 3: Wire `DatabaseModule` into `AppModule` and build**

```typescript
// apps/zalo-bot/src/app.module.ts — add import
import { DatabaseModule } from './infrastructure/database/database.module';

@Module({
  controllers: [HealthController],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env.shared'],
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
  ],
})
export class AppModule {}
```

Run: `npx turbo run build --filter=@wispace/zalo-bot`
Expected: build succeeds (requires `DB_*` vars to be resolvable at runtime, but `build`/`typecheck` don't need a live DB connection).

- [ ] **Step 4: Commit**

```bash
git add apps/zalo-bot/src/infrastructure apps/zalo-bot/src/app.module.ts
git commit -m "feat(zalo-bot): add TypeORM entities and DatabaseModule"
```

---

### Task 4: Webhook signature verification + domain types

**Files:**
- Create: `apps/zalo-bot/src/modules/zalo-webhook/domain/entities/zalo-webhook-event.types.ts`
- Create: `apps/zalo-bot/src/modules/zalo-webhook/application/utils/zalo-webhook-signature.utils.ts`
- Test: `apps/zalo-bot/src/modules/zalo-webhook/application/utils/zalo-webhook-signature.utils.spec.ts`

**Interfaces:**
- Produces: `verifyZaloWebhookSignature(params: { appId: string; rawBody: string; timestamp: string; oaSecretKey: string; signatureHeader: string | undefined }): boolean`, `ZaloWebhookEvent` type — consumed by Task 6's `ZaloWebhookController`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/zalo-bot/src/modules/zalo-webhook/application/utils/zalo-webhook-signature.utils.spec.ts
import { createHash } from 'crypto';
import { verifyZaloWebhookSignature } from './zalo-webhook-signature.utils';

function buildSignature(
  appId: string,
  rawBody: string,
  timestamp: string,
  secret: string,
): string {
  return createHash('sha256')
    .update(appId + rawBody + timestamp + secret)
    .digest('hex');
}

describe('verifyZaloWebhookSignature', () => {
  const appId = 'app-1';
  const rawBody = '{"event_name":"user_send_text"}';
  const timestamp = '1690000000000';
  const secret = 'oa-secret';

  it('returns true for a correctly computed signature', () => {
    const signatureHeader = buildSignature(appId, rawBody, timestamp, secret);
    expect(
      verifyZaloWebhookSignature({
        appId,
        rawBody,
        timestamp,
        oaSecretKey: secret,
        signatureHeader,
      }),
    ).toBe(true);
  });

  it('returns false for a tampered body', () => {
    const signatureHeader = buildSignature(appId, rawBody, timestamp, secret);
    expect(
      verifyZaloWebhookSignature({
        appId,
        rawBody: '{"event_name":"user_send_image"}',
        timestamp,
        oaSecretKey: secret,
        signatureHeader,
      }),
    ).toBe(false);
  });

  it('returns false when the signature header is missing', () => {
    expect(
      verifyZaloWebhookSignature({
        appId,
        rawBody,
        timestamp,
        oaSecretKey: secret,
        signatureHeader: undefined,
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx turbo run test --filter=@wispace/zalo-bot -- zalo-webhook-signature`
Expected: FAIL with "Cannot find module './zalo-webhook-signature.utils'"

- [ ] **Step 3: Implement the signature utility**

```typescript
// apps/zalo-bot/src/modules/zalo-webhook/application/utils/zalo-webhook-signature.utils.ts
import { createHash, timingSafeEqual } from 'crypto';

/**
 * Zalo webhook signature: mac = sha256(appId + rawBody + timestamp + oaSecretKey).
 * Header name is `X-ZEvent-Signature` (see zalo-webhook.controller.ts).
 */
export function verifyZaloWebhookSignature(params: {
  appId: string;
  rawBody: string;
  timestamp: string;
  oaSecretKey: string;
  signatureHeader: string | undefined;
}): boolean {
  const { appId, rawBody, timestamp, oaSecretKey, signatureHeader } = params;

  if (!signatureHeader) {
    return false;
  }

  const expected = createHash('sha256')
    .update(appId + rawBody + timestamp + oaSecretKey)
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signatureHeader, 'utf8');

  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }

  return timingSafeEqual(expectedBuf, actualBuf);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx turbo run test --filter=@wispace/zalo-bot -- zalo-webhook-signature`
Expected: PASS (3 tests)

- [ ] **Step 5: Add the webhook event domain type (no test — pure type)**

```typescript
// apps/zalo-bot/src/modules/zalo-webhook/domain/entities/zalo-webhook-event.types.ts
export type ZaloWebhookEventName =
  | 'user_send_text'
  | 'user_send_image'
  | 'user_send_sticker'
  | 'user_send_file'
  | 'user_send_location'
  | 'follow'
  | 'unfollow'
  | 'oa_send_text'
  | 'oa_send_image'
  | 'oa_send_list'
  | 'oa_send_file'
  | 'oa_send_sticker'
  | string;

export interface ZaloWebhookEvent {
  app_id: string;
  event_name: ZaloWebhookEventName;
  timestamp: string;
  sender?: { id: string };
  recipient?: { id: string };
  follower?: { id: string };
  oa_id?: string;
  user_id_by_app?: string;
  message?: {
    text?: string;
    msg_id?: string;
  };
}
```

- [ ] **Step 6: Commit**

```bash
git add apps/zalo-bot/src/modules/zalo-webhook
git commit -m "feat(zalo-bot): add webhook signature verification util"
```

---

### Task 5: `ZaloTokenService` + `ZaloTokenRefreshService` (OA token lifecycle)

**Files:**
- Create: `apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-token.service.ts`
- Test: `apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-token.service.spec.ts`
- Create: `apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-token-refresh.service.ts`
- Test: `apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-token-refresh.service.spec.ts`

**Interfaces:**
- Consumes: `ZaloOaTokenEntity` (Task 3).
- Produces: `ZaloTokenService.getValidAccessToken(): Promise<string>`, `ZaloTokenService.refreshNow(): Promise<void>` — consumed by Task 9's `ZaloOutboundService` and by `ZaloTokenRefreshService`'s cron.

- [ ] **Step 1: Write the failing test for `ZaloTokenService`**

```typescript
// apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-token.service.spec.ts
import { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import { ZaloTokenService } from './zalo-token.service';
import { ZaloOaTokenEntity } from '../../../../infrastructure/database/entities/zalo-oa-token.entity';

function buildConfig(): ConfigService {
  return {
    getOrThrow: (key: string) =>
      ({ ZALO_APP_ID: 'app-1', ZALO_APP_SECRET_KEY: 'secret-1' })[key],
  } as unknown as ConfigService;
}

describe('ZaloTokenService', () => {
  it('returns the stored access_token when still valid', async () => {
    const row = {
      id: '1',
      accessToken: 'valid-token',
      refreshToken: 'refresh-1',
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      updatedAt: new Date(),
    };
    const repo = {
      findOne: jest.fn().mockResolvedValue(row),
      update: jest.fn(),
    } as unknown as Repository<ZaloOaTokenEntity>;

    const service = new ZaloTokenService(buildConfig(), repo, {
      fetch: jest.fn(),
    });

    await expect(service.getValidAccessToken()).resolves.toBe('valid-token');
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('refreshes and persists a new token pair when access_token is expired', async () => {
    const row = {
      id: '1',
      accessToken: 'stale-token',
      refreshToken: 'refresh-1',
      accessTokenExpiresAt: new Date(Date.now() - 1000),
      refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      updatedAt: new Date(),
    };
    const repo = {
      findOne: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue(undefined),
    } as unknown as Repository<ZaloOaTokenEntity>;

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: '3600',
        refresh_token_expires_in: '2592000',
      }),
    });

    const service = new ZaloTokenService(buildConfig(), repo, {
      fetch: fetchMock,
    });

    const token = await service.getValidAccessToken();

    expect(token).toBe('new-access-token');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://oauth.zaloapp.com/v4/access_token',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(repo.update).toHaveBeenCalledWith(
      '1',
      expect.objectContaining({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
      }),
    );
  });

  it('throws when no token row exists (bootstrap not done)', async () => {
    const repo = {
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
    } as unknown as Repository<ZaloOaTokenEntity>;

    const service = new ZaloTokenService(buildConfig(), repo, {
      fetch: jest.fn(),
    });

    await expect(service.getValidAccessToken()).rejects.toThrow(
      'zalo_oa_tokens is empty',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx turbo run test --filter=@wispace/zalo-bot -- zalo-token.service`
Expected: FAIL with "Cannot find module './zalo-token.service'"

- [ ] **Step 3: Implement `ZaloTokenService`**

```typescript
// apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-token.service.ts
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ZaloOaTokenEntity } from '../../../../infrastructure/database/entities/zalo-oa-token.entity';

const ZALO_TOKEN_ENDPOINT = 'https://oauth.zaloapp.com/v4/access_token';
const EXPIRY_BUFFER_MS = 10 * 60 * 1000;

interface FetchLike {
  fetch: typeof fetch;
}

interface ZaloAccessTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: string;
  refresh_token_expires_in: string;
}

/**
 * Owns the single-row `zalo_oa_tokens` OA server-to-server token pair.
 * access_token: 1h, refresh_token: 30 days, single-use (must persist the new
 * pair returned by every refresh call) — see spec §5.1. Bootstrap (first
 * token pair) is a manual one-time ops step, not handled here.
 */
@Injectable()
export class ZaloTokenService {
  private readonly logger = new Logger(ZaloTokenService.name);

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(ZaloOaTokenEntity)
    private readonly repo: Repository<ZaloOaTokenEntity>,
    private readonly http: FetchLike = { fetch },
  ) {}

  async getValidAccessToken(): Promise<string> {
    const row = await this.repo.findOne({ where: {}, order: { id: 'DESC' } });
    if (!row) {
      throw new InternalServerErrorException(
        'zalo_oa_tokens is empty — run the OA token bootstrap step first',
      );
    }

    const expiresAt = row.accessTokenExpiresAt.getTime();
    if (expiresAt - EXPIRY_BUFFER_MS > Date.now()) {
      return row.accessToken;
    }

    return this.refresh(row);
  }

  /** Force a refresh regardless of current expiry — used by the cron (Task 5b). */
  async refreshNow(): Promise<void> {
    const row = await this.repo.findOne({ where: {}, order: { id: 'DESC' } });
    if (!row) {
      this.logger.warn('refreshNow skipped — zalo_oa_tokens is empty');
      return;
    }
    await this.refresh(row);
  }

  private async refresh(row: ZaloOaTokenEntity): Promise<string> {
    const appId = this.configService.getOrThrow<string>('ZALO_APP_ID');
    const secretKey = this.configService.getOrThrow<string>(
      'ZALO_APP_SECRET_KEY',
    );

    const response = await this.http.fetch(ZALO_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        secret_key: secretKey,
      },
      body: new URLSearchParams({
        refresh_token: row.refreshToken,
        app_id: appId,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      throw new InternalServerErrorException(
        `Zalo OA token refresh failed: HTTP ${response.status}`,
      );
    }

    const payload = (await response.json()) as ZaloAccessTokenResponse;
    const now = Date.now();

    await this.repo.update(row.id, {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      accessTokenExpiresAt: new Date(
        now + Number(payload.expires_in) * 1000,
      ),
      refreshTokenExpiresAt: new Date(
        now + Number(payload.refresh_token_expires_in) * 1000,
      ),
      updatedAt: new Date(now),
    });

    this.logger.log('Zalo OA access_token refreshed');
    return payload.access_token;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx turbo run test --filter=@wispace/zalo-bot -- zalo-token.service`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the failing test for `ZaloTokenRefreshService`**

```typescript
// apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-token-refresh.service.spec.ts
import { ZaloTokenRefreshService } from './zalo-token-refresh.service';
import { ZaloTokenService } from './zalo-token.service';

describe('ZaloTokenRefreshService', () => {
  it('delegates to ZaloTokenService.refreshNow on the scheduled tick', async () => {
    const refreshNow = jest.fn().mockResolvedValue(undefined);
    const tokenService = { refreshNow } as unknown as ZaloTokenService;

    const service = new ZaloTokenRefreshService(tokenService);
    await service.handleCron();

    expect(refreshNow).toHaveBeenCalledTimes(1);
  });

  it('logs and swallows errors so one failed tick does not crash the cron', async () => {
    const refreshNow = jest.fn().mockRejectedValue(new Error('network down'));
    const tokenService = { refreshNow } as unknown as ZaloTokenService;

    const service = new ZaloTokenRefreshService(tokenService);

    await expect(service.handleCron()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx turbo run test --filter=@wispace/zalo-bot -- zalo-token-refresh.service`
Expected: FAIL with "Cannot find module './zalo-token-refresh.service'"

- [ ] **Step 7: Implement `ZaloTokenRefreshService`**

```typescript
// apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-token-refresh.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ZaloTokenService } from './zalo-token.service';

/**
 * Refreshes the OA access_token proactively (every 45 min — access_token
 * lifetime is 1h, so this comfortably beats the 10-min buffer in
 * ZaloTokenService.getValidAccessToken) — see spec §5.1.
 */
@Injectable()
export class ZaloTokenRefreshService {
  private readonly logger = new Logger(ZaloTokenRefreshService.name);

  constructor(private readonly tokenService: ZaloTokenService) {}

  @Cron('0 */45 * * * *')
  async handleCron(): Promise<void> {
    try {
      await this.tokenService.refreshNow();
    } catch (error) {
      this.logger.error(
        `Zalo OA token refresh cron failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx turbo run test --filter=@wispace/zalo-bot -- zalo-token-refresh.service`
Expected: PASS (2 tests)

- [ ] **Step 9: Commit**

```bash
git add apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-token.service.ts apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-token.service.spec.ts apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-token-refresh.service.ts apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-token-refresh.service.spec.ts
git commit -m "feat(zalo-bot): add OA access-token lifecycle (get/refresh + cron)"
```

---

### Task 6: `ZaloWebhookController`

**Files:**
- Create: `apps/zalo-bot/src/modules/zalo-webhook/presentation/controllers/zalo-webhook.controller.ts`
- Test: `apps/zalo-bot/src/modules/zalo-webhook/presentation/controllers/zalo-webhook.controller.spec.ts`

**Interfaces:**
- Consumes: `verifyZaloWebhookSignature` (Task 4), `ZaloWebhookEvent` type (Task 4). Declares a small port `ZaloIncomingMessageHandler { handleIncomingMessage(senderId: string, text: string): Promise<void> }` and `ZaloFollowHandler { handleFollow(senderId: string): Promise<void> }` — implemented for real by `ZaloChatService` in Task 12; this task uses a hand-rolled stub in its own test.
- Produces: `POST /zalo/webhook` route — this is the final consumer-facing piece; Task 12 injects the real handler.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/zalo-bot/src/modules/zalo-webhook/presentation/controllers/zalo-webhook.controller.spec.ts
import { createHash } from 'crypto';
import type { Request } from 'express';
import { ZaloWebhookController } from './zalo-webhook.controller';

function buildRequest(rawBody: string): Request {
  return { rawBody: Buffer.from(rawBody, 'utf8') } as unknown as Request;
}

function sign(appId: string, rawBody: string, timestamp: string, secret: string) {
  return createHash('sha256')
    .update(appId + rawBody + timestamp + secret)
    .digest('hex');
}

describe('ZaloWebhookController', () => {
  const appId = 'app-1';
  const oaSecretKey = 'oa-secret';
  const config = {
    getOrThrow: (key: string) =>
      ({ ZALO_APP_ID: appId, ZALO_OA_SECRET_KEY: oaSecretKey })[key],
  } as any;

  it('rejects a request with an invalid signature', async () => {
    const handleIncomingMessage = jest.fn();
    const handleFollow = jest.fn();
    const controller = new ZaloWebhookController(config, {
      handleIncomingMessage,
      handleFollow,
    });

    const body = { event_name: 'user_send_text' };
    const rawBody = JSON.stringify(body);
    const timestamp = '1690000000000';

    await expect(
      controller.handleWebhook(
        body as any,
        buildRequest(rawBody),
        'wrong-signature',
        timestamp,
      ),
    ).rejects.toThrow();
    expect(handleIncomingMessage).not.toHaveBeenCalled();
  });

  it('dispatches user_send_text to handleIncomingMessage', async () => {
    const handleIncomingMessage = jest.fn().mockResolvedValue(undefined);
    const handleFollow = jest.fn();
    const controller = new ZaloWebhookController(config, {
      handleIncomingMessage,
      handleFollow,
    });

    const body = {
      app_id: appId,
      event_name: 'user_send_text',
      sender: { id: 'user-1' },
      message: { text: 'hello', msg_id: 'm1' },
      timestamp: '1690000000000',
    };
    const rawBody = JSON.stringify(body);
    const signature = sign(appId, rawBody, body.timestamp, oaSecretKey);

    await controller.handleWebhook(
      body as any,
      buildRequest(rawBody),
      signature,
      body.timestamp,
    );

    expect(handleIncomingMessage).toHaveBeenCalledWith('user-1', 'hello');
  });

  it('dispatches follow to handleFollow', async () => {
    const handleIncomingMessage = jest.fn();
    const handleFollow = jest.fn().mockResolvedValue(undefined);
    const controller = new ZaloWebhookController(config, {
      handleIncomingMessage,
      handleFollow,
    });

    const body = {
      app_id: appId,
      event_name: 'follow',
      follower: { id: 'user-2' },
      timestamp: '1690000000000',
    };
    const rawBody = JSON.stringify(body);
    const signature = sign(appId, rawBody, body.timestamp, oaSecretKey);

    await controller.handleWebhook(
      body as any,
      buildRequest(rawBody),
      signature,
      body.timestamp,
    );

    expect(handleFollow).toHaveBeenCalledWith('user-2');
  });

  it('ignores oa_send_* echo events', async () => {
    const handleIncomingMessage = jest.fn();
    const handleFollow = jest.fn();
    const controller = new ZaloWebhookController(config, {
      handleIncomingMessage,
      handleFollow,
    });

    const body = {
      app_id: appId,
      event_name: 'oa_send_text',
      recipient: { id: 'user-1' },
      timestamp: '1690000000000',
    };
    const rawBody = JSON.stringify(body);
    const signature = sign(appId, rawBody, body.timestamp, oaSecretKey);

    await controller.handleWebhook(
      body as any,
      buildRequest(rawBody),
      signature,
      body.timestamp,
    );

    expect(handleIncomingMessage).not.toHaveBeenCalled();
    expect(handleFollow).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx turbo run test --filter=@wispace/zalo-bot -- zalo-webhook.controller`
Expected: FAIL with "Cannot find module './zalo-webhook.controller'"

- [ ] **Step 3: Implement `ZaloWebhookController`**

```typescript
// apps/zalo-bot/src/modules/zalo-webhook/presentation/controllers/zalo-webhook.controller.ts
import {
  Body,
  Controller,
  Headers,
  Inject,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { verifyZaloWebhookSignature } from '../../application/utils/zalo-webhook-signature.utils';
import type { ZaloWebhookEvent } from '../../domain/entities/zalo-webhook-event.types';

export const ZALO_WEBHOOK_HANDLER = 'ZALO_WEBHOOK_HANDLER';

export interface ZaloWebhookHandler {
  handleIncomingMessage(senderId: string, text: string): Promise<void>;
  handleFollow(senderId: string): Promise<void>;
}

@Controller('zalo/webhook')
export class ZaloWebhookController {
  private readonly logger = new Logger(ZaloWebhookController.name);

  constructor(
    private readonly configService: ConfigService,
    @Inject(ZALO_WEBHOOK_HANDLER)
    private readonly handler: ZaloWebhookHandler,
  ) {}

  @Post()
  async handleWebhook(
    @Body() body: ZaloWebhookEvent,
    @Req() req: Request,
    @Headers('x-zevent-signature') signatureHeader: string | undefined,
    @Headers('x-zevent-timestamp') timestampHeader: string | undefined,
  ): Promise<{ received: true }> {
    const appId = this.configService.getOrThrow<string>('ZALO_APP_ID');
    const oaSecretKey = this.configService.getOrThrow<string>(
      'ZALO_OA_SECRET_KEY',
    );
    const rawBody = (req.rawBody ?? Buffer.from(JSON.stringify(body))).toString(
      'utf8',
    );
    const timestamp = timestampHeader ?? body.timestamp;

    const valid = verifyZaloWebhookSignature({
      appId,
      rawBody,
      timestamp,
      oaSecretKey,
      signatureHeader,
    });

    if (!valid) {
      this.logger.warn('Rejected webhook request — signature mismatch');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    await this.dispatch(body);
    return { received: true };
  }

  private async dispatch(event: ZaloWebhookEvent): Promise<void> {
    switch (event.event_name) {
      case 'user_send_text': {
        const senderId = event.sender?.id;
        const text = event.message?.text;
        if (senderId && text) {
          await this.handler.handleIncomingMessage(senderId, text);
        }
        return;
      }
      case 'follow': {
        const followerId = event.follower?.id;
        if (followerId) {
          await this.handler.handleFollow(followerId);
        }
        return;
      }
      case 'unfollow':
        this.logger.log(`User unfollowed: ${event.follower?.id ?? 'unknown'}`);
        return;
      default:
        if (event.event_name.startsWith('oa_send_')) {
          // Echo of our own outbound message — ignore to avoid loops.
          return;
        }
        this.logger.debug(`Unhandled event_name=${event.event_name}`);
        return;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx turbo run test --filter=@wispace/zalo-bot -- zalo-webhook.controller`
Expected: PASS (4 tests)

- [ ] **Step 5: Create `zalo-webhook.module.ts` (handler binding deferred to Task 12/13's `AppModule` wiring)**

```typescript
// apps/zalo-bot/src/modules/zalo-webhook/zalo-webhook.module.ts
import { Module } from '@nestjs/common';
import { ZaloWebhookController } from './presentation/controllers/zalo-webhook.controller';

@Module({
  controllers: [ZaloWebhookController],
})
export class ZaloWebhookModule {}
```

**Note:** this module does not compile standalone yet (the `ZALO_WEBHOOK_HANDLER` provider is bound in Task 13, when `ZaloChatService` exists to implement it) — Task 13 modifies this file to add the provider and the `ZaloChatModule` import.

- [ ] **Step 6: Commit**

```bash
git add apps/zalo-bot/src/modules/zalo-webhook
git commit -m "feat(zalo-bot): add ZaloWebhookController (signature verify + event dispatch)"
```

---

### Task 7: `ZaloChatHistoryService` + `ZaloOutboundService`

**Files:**
- Create: `apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-chat-history.service.ts`
- Test: `apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-chat-history.service.spec.ts`
- Create: `apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-outbound.service.ts`
- Test: `apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-outbound.service.spec.ts`

**Interfaces:**
- Consumes: `ZaloTokenService.getValidAccessToken()` (Task 5).
- Produces: `ZaloChatHistoryService.getHistory(zaloUserId): Promise<ChatHistoryMessage[]>`, `.appendTurn(zaloUserId, userText, assistantText): Promise<void>`; `ZaloOutboundService.sendText(zaloUserId, text): Promise<void>` — both consumed by Task 8 (`ZaloAgentService`) and Task 12 (`ZaloChatService`).

- [ ] **Step 1: Write the failing test for `ZaloChatHistoryService`**

```typescript
// apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-chat-history.service.spec.ts
import { ConfigService } from '@nestjs/config';
import { ZaloChatHistoryService } from './zalo-chat-history.service';

describe('ZaloChatHistoryService', () => {
  it('returns an empty history for a new user, then reflects appended turns', async () => {
    const config = {
      get: () => undefined,
    } as unknown as ConfigService;
    const service = new ZaloChatHistoryService(config);

    await expect(service.getHistory('zalo-1')).resolves.toEqual([]);

    await service.appendTurn('zalo-1', 'hi', 'hello there');
    const history = await service.getHistory('zalo-1');

    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ role: 'user', content: 'hi' });
    expect(history[1]).toMatchObject({ role: 'assistant', content: 'hello there' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx turbo run test --filter=@wispace/zalo-bot -- zalo-chat-history.service`
Expected: FAIL with "Cannot find module './zalo-chat-history.service'"

- [ ] **Step 3: Implement `ZaloChatHistoryService`**

```typescript
// apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-chat-history.service.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MemoryChatHistoryStore,
  type ChatHistoryMessage,
} from '@wispace/chat-history';

const DEFAULT_MAX_MESSAGES = 20;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

/**
 * In-memory only (MVP) — lost on process restart, not shared across pods.
 * Same trade-off as apps/discord-bot's DiscordChatHistoryService — see spec
 * §11.7 for the Redis-backed future work.
 */
@Injectable()
export class ZaloChatHistoryService {
  private readonly store: MemoryChatHistoryStore;

  constructor(configService: ConfigService) {
    const ttlMs =
      Number(configService.get<string>('ZALO_CHAT_HISTORY_TTL_MS')) ||
      DEFAULT_TTL_MS;
    const maxMessages =
      Number(configService.get<string>('ZALO_CHAT_HISTORY_MAX_MESSAGES')) ||
      DEFAULT_MAX_MESSAGES;

    this.store = new MemoryChatHistoryStore({ ttlMs, maxMessages });
  }

  getHistory(zaloUserId: string): Promise<ChatHistoryMessage[]> {
    return this.store.getHistory(zaloUserId);
  }

  appendTurn(
    zaloUserId: string,
    userText: string,
    assistantText: string,
  ): Promise<void> {
    return this.store.appendTurn(zaloUserId, userText, assistantText);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx turbo run test --filter=@wispace/zalo-bot -- zalo-chat-history.service`
Expected: PASS

- [ ] **Step 5: Write the failing test for `ZaloOutboundService`**

```typescript
// apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-outbound.service.spec.ts
import { ZaloOutboundService } from './zalo-outbound.service';
import { ZaloTokenService } from '../../../zalo-oauth/application/services/zalo-token.service';

describe('ZaloOutboundService', () => {
  it('sends a text consultation message with the current access token', async () => {
    const getValidAccessToken = jest.fn().mockResolvedValue('token-abc');
    const tokenService = { getValidAccessToken } as unknown as ZaloTokenService;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ error: 0, message: 'Success', data: {} }),
    });

    const service = new ZaloOutboundService(tokenService, fetchMock as any);
    await service.sendText('zalo-1', 'hello');

    expect(getValidAccessToken).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openapi.zalo.me/v3.0/oa/message/cs',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ access_token: 'token-abc' }),
      }),
    );
    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body as string);
    expect(body).toEqual({
      recipient: { user_id: 'zalo-1' },
      message: { text: 'hello' },
    });
  });

  it('logs and swallows errors instead of throwing (best-effort send, matches Discord pattern)', async () => {
    const tokenService = {
      getValidAccessToken: jest.fn().mockResolvedValue('token-abc'),
    } as unknown as ZaloTokenService;
    const fetchMock = jest.fn().mockRejectedValue(new Error('network down'));

    const service = new ZaloOutboundService(tokenService, fetchMock as any);

    await expect(service.sendText('zalo-1', 'hello')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx turbo run test --filter=@wispace/zalo-bot -- zalo-outbound.service`
Expected: FAIL with "Cannot find module './zalo-outbound.service'"

- [ ] **Step 7: Implement `ZaloOutboundService`**

```typescript
// apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-outbound.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ZaloTokenService } from '../../../zalo-oauth/application/services/zalo-token.service';

const SEND_TEXT_ENDPOINT = 'https://openapi.zalo.me/v3.0/oa/message/cs';

/**
 * MessageSenderPort-equivalent for Zalo — sends a "consultation" text
 * message (works within the 48h window; ZNS for outside that window is
 * future work, see spec §11.4).
 */
@Injectable()
export class ZaloOutboundService {
  private readonly logger = new Logger(ZaloOutboundService.name);

  constructor(
    private readonly tokenService: ZaloTokenService,
    private readonly httpFetch: typeof fetch = fetch,
  ) {}

  async sendText(zaloUserId: string, text: string): Promise<void> {
    try {
      const accessToken = await this.tokenService.getValidAccessToken();

      const response = await this.httpFetch(SEND_TEXT_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          access_token: accessToken,
        },
        body: JSON.stringify({
          recipient: { user_id: zaloUserId },
          message: { text },
        }),
      });

      if (!response.ok) {
        this.logger.warn(
          `Zalo send message failed HTTP ${response.status} for zaloUserId=${zaloUserId}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Failed to send Zalo message to zaloUserId=${zaloUserId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx turbo run test --filter=@wispace/zalo-bot -- zalo-outbound.service`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-chat-history.service.ts apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-chat-history.service.spec.ts apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-outbound.service.ts apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-outbound.service.spec.ts
git commit -m "feat(zalo-bot): add chat history store and outbound message sender"
```

---

### Task 8: `ZaloAgentToolsService` (stub) + domain types + system prompt

**Files:**
- Create: `apps/zalo-bot/src/modules/zalo-chat/domain/entities/zalo-chat.types.ts`
- Create: `apps/zalo-bot/src/modules/zalo-chat/application/agent/zalo-agent-tools.service.ts`
- Test: `apps/zalo-bot/src/modules/zalo-chat/application/agent/zalo-agent-tools.service.spec.ts`
- Create: `apps/zalo-bot/src/shared/prompts/zalo-chat.system.txt`

**Interfaces:**
- Produces: `ZaloAgentToolContext`, `ZaloAgentInput`, `ZaloAgentReply` types; `ZaloAgentToolsService.execute(toolName, argsJson, ctx): Promise<unknown>` (implements `ToolExecutorPort<ZaloAgentToolContext>` from `@wispace/llm-agent`) — consumed by Task 9's `ZaloAgentService`.

- [ ] **Step 1: Create domain types (no test — pure types, mirrors `discord-chat.types.ts`)**

```typescript
// apps/zalo-bot/src/modules/zalo-chat/domain/entities/zalo-chat.types.ts
export interface ZaloAgentToolContext {
  zaloUserId: string;
  /** WISPACE userId if the Zalo account is linked; undefined otherwise. */
  userId?: number;
}

export interface ZaloAgentReply {
  text: string;
}

export interface ZaloAgentInput {
  zaloUserId: string;
  userId?: number;
  userText: string;
  /** Zalo message msg_id — LLM usage correlation id. */
  correlationId?: string;
}
```

- [ ] **Step 2: Write the failing test for `ZaloAgentToolsService`**

```typescript
// apps/zalo-bot/src/modules/zalo-chat/application/agent/zalo-agent-tools.service.spec.ts
import { ZaloAgentToolsService } from './zalo-agent-tools.service';
import type { ZaloAgentToolContext } from '../../domain/entities/zalo-chat.types';

describe('ZaloAgentToolsService', () => {
  const service = new ZaloAgentToolsService();

  it('returns available:false with a link-account message when userId is not linked', async () => {
    const ctx: ZaloAgentToolContext = { zaloUserId: 'zalo-1' };
    const result = await service.execute('get_user_goals', '{}', ctx);
    expect(result).toEqual({
      available: false,
      message: expect.stringContaining('liên kết'),
    });
  });

  it('returns available:false with a not-yet-built message when userId is linked', async () => {
    const ctx: ZaloAgentToolContext = { zaloUserId: 'zalo-1', userId: 42 };
    const result = await service.execute('get_user_goals', '{}', ctx);
    expect(result).toEqual({
      available: false,
      message: expect.stringContaining('phát triển'),
    });
  });

  it('returns an error object for an unknown tool name', async () => {
    const ctx: ZaloAgentToolContext = { zaloUserId: 'zalo-1' };
    const result = await service.execute('not_a_real_tool', '{}', ctx);
    expect(result).toEqual({ error: expect.stringContaining('Unknown tool') });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx turbo run test --filter=@wispace/zalo-bot -- zalo-agent-tools.service`
Expected: FAIL with "Cannot find module './zalo-agent-tools.service'"

- [ ] **Step 4: Implement `ZaloAgentToolsService`**

```typescript
// apps/zalo-bot/src/modules/zalo-chat/application/agent/zalo-agent-tools.service.ts
import { Injectable } from '@nestjs/common';
import { isAgentToolName } from '@wispace/llm-agent';
import type { ZaloAgentToolContext } from '../../domain/entities/zalo-chat.types';

const NOT_LINKED_MESSAGE =
  'Bạn chưa liên kết tài khoản WISPACE với Zalo. Nhắn "liên kết" để lấy link kết nối tài khoản nhé.';

const NOT_BUILT_YET_MESSAGE =
  'Tính năng này đang được phát triển cho Zalo — bạn dùng WISPACE qua Messenger/Discord cho việc này nhé.';

/**
 * MVP stub — implements ToolExecutorPort<ZaloAgentToolContext> from
 * @wispace/llm-agent but every AGENT_TOOLS entry is unavailable, whether or
 * not the account is linked. Real tool wiring (get_user_goals, calendar,
 * reschedule...) is future work — see spec §11.1.
 */
@Injectable()
export class ZaloAgentToolsService {
  async execute(
    toolName: string,
    _argsJson: string,
    ctx: ZaloAgentToolContext,
  ): Promise<unknown> {
    if (!isAgentToolName(toolName)) {
      return { error: `Unknown tool: ${toolName}` };
    }

    if (!ctx.userId) {
      return { available: false, message: NOT_LINKED_MESSAGE };
    }

    return { available: false, message: NOT_BUILT_YET_MESSAGE };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx turbo run test --filter=@wispace/zalo-bot -- zalo-agent-tools.service`
Expected: PASS

- [ ] **Step 6: Create the system prompt file**

```text
// apps/zalo-bot/src/shared/prompts/zalo-chat.system.txt
Bạn là trợ lý học tập AI của WISPACE, đang trò chuyện với học viên qua Zalo Official Account.

Trả lời ngắn gọn, thân thiện, bằng tiếng Việt. Nếu học viên hỏi về tiến độ học, lịch học, hoặc mục tiêu điểm số — các tính năng này hiện chưa khả dụng trên Zalo, hãy gợi ý học viên dùng WISPACE qua Messenger hoặc liên kết tài khoản WISPACE để mình hỗ trợ tốt hơn trong tương lai.

Không bịa thông tin về lịch học hay điểm số của học viên nếu không có dữ liệu thật.
```

- [ ] **Step 7: Commit**

```bash
git add apps/zalo-bot/src/modules/zalo-chat/domain apps/zalo-bot/src/modules/zalo-chat/application/agent apps/zalo-bot/src/shared
git commit -m "feat(zalo-bot): add stub tool executor and system prompt"
```

---

### Task 9: `ZaloAgentService` (LLM agent adapter)

**Files:**
- Create: `apps/zalo-bot/src/modules/zalo-chat/application/agent/zalo-agent.service.ts`

**Interfaces:**
- Consumes: `ZaloAgentToolsService` (Task 8), `ZaloChatHistoryService` (Task 7), `LlmAgentService`/`LlmAgentPorts`/`NOOP_METRICS_PORT`/`loadSystemPromptFile` from `@wispace/llm-agent`.
- Produces: `ZaloAgentService.reply(input: ZaloAgentInput): Promise<ZaloAgentReply>` — consumed by Task 12's `ZaloChatService`.

No dedicated unit test for this task — it is a thin wiring adapter around `@wispace/llm-agent`, matching `apps/discord-bot`'s `DiscordAgentService` (also untested directly; its ports are exercised through `ZaloAgentToolsService`'s own tests and, eventually, integration testing against a real OA). Usage/safety recording is intentionally omitted for this MVP (no `packages/chat-metering` wiring — Global Constraints).

- [ ] **Step 1: Implement `ZaloAgentService`**

```typescript
// apps/zalo-bot/src/modules/zalo-chat/application/agent/zalo-agent.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LlmAgentService,
  LlmAgentPorts,
  NOOP_METRICS_PORT,
  ToolExecutorPort,
  type LlmProviderAdapter,
  loadSystemPromptFile,
} from '@wispace/llm-agent';
import { join } from 'path';
import type {
  ZaloAgentInput,
  ZaloAgentReply,
  ZaloAgentToolContext,
} from '../../domain/entities/zalo-chat.types';
import { ZaloAgentToolsService } from './zalo-agent-tools.service';
import { ZaloChatHistoryService } from '../services/zalo-chat-history.service';

const FEATURE = 'FREE_FORM_CHAT';
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_BACKOFF_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thin NestJS adapter around @wispace/llm-agent's platform-agnostic
 * orchestration loop — Zalo counterpart to DiscordAgentService/
 * MessengerAgentService. No usage/safety recording in this MVP (no
 * packages/chat-metering wiring — see spec §1/Global Constraints).
 */
@Injectable()
export class ZaloAgentService {
  private readonly logger = new Logger(ZaloAgentService.name);
  private readonly promptDir = join(__dirname, '../../../../shared/prompts');
  private agent?: LlmAgentService<ZaloAgentToolContext>;

  constructor(
    private readonly configService: ConfigService,
    private readonly toolsService: ZaloAgentToolsService,
    private readonly historyService: ZaloChatHistoryService,
    @Inject('LLM_PROVIDER_ADAPTER')
    private readonly adapter: LlmProviderAdapter,
  ) {}

  async reply(input: ZaloAgentInput): Promise<ZaloAgentReply> {
    if (!this.agent) {
      this.agent = this.buildAgent();
    }

    const toolContext: ZaloAgentToolContext = {
      zaloUserId: input.zaloUserId,
      userId: input.userId,
    };

    const history = await this.historyService.getHistory(input.zaloUserId);

    const result = await this.agent.reply(
      {
        externalUserId: input.zaloUserId,
        userId: input.userId,
        userText: input.userText,
        systemPrompt: this.buildSystemPrompt(),
        history,
        correlationId: input.correlationId,
      },
      toolContext,
    );

    await this.historyService.appendTurn(
      input.zaloUserId,
      input.userText,
      result.text,
    );

    return { text: result.text };
  }

  private buildAgent(): LlmAgentService<ZaloAgentToolContext> {
    const toolExecutor: ToolExecutorPort<ZaloAgentToolContext> = {
      execute: (toolName, argsJson, ctx) =>
        this.toolsService.execute(toolName, argsJson, ctx),
    };

    const ports: LlmAgentPorts<ZaloAgentToolContext> = {
      llmExecution: { run: (fn) => this.runWithRetry(fn) },
      usageRecorder: { recordFromCompletion: () => undefined },
      safetyEvents: { recordGroundingWarning: () => undefined },
      metrics: NOOP_METRICS_PORT,
      toolExecutor,
      adapter: this.adapter,
      logger: {
        warn: (message) => this.logger.warn(message),
        debug: (message) => this.logger.debug(message),
      },
    };

    return new LlmAgentService<ZaloAgentToolContext>(
      {
        maxToolRounds: Number(
          this.configService.get<string>('OPENAI_MAX_TOOL_ROUNDS'),
        ),
        maxContextChars: Number(
          this.configService.get<string>('OPENAI_MAX_CONTEXT_CHARS'),
        ),
        maxOutputTokens: Number(
          this.configService.get<string>('OPENAI_MAX_OUTPUT_TOKENS'),
        ),
      },
      ports,
    );
  }

  private async runWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (
          !this.adapter.isRetryableError(error) ||
          attempt >= RETRY_MAX_ATTEMPTS
        ) {
          throw error;
        }
        const backoffMs = RETRY_BASE_BACKOFF_MS * attempt;
        this.logger.warn(
          `LLM provider retry attempt=${attempt}/${RETRY_MAX_ATTEMPTS} backoffMs=${backoffMs}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await sleep(backoffMs);
      }
    }

    throw lastError;
  }

  private buildSystemPrompt(): string {
    return loadSystemPromptFile(this.promptDir, 'zalo-chat.system.txt');
  }
}
```

- [ ] **Step 2: Verify it typechecks (no runtime test — see task rationale above)**

Run: `npx turbo run typecheck --filter=@wispace/zalo-bot`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add apps/zalo-bot/src/modules/zalo-chat/application/agent/zalo-agent.service.ts
git commit -m "feat(zalo-bot): add ZaloAgentService LLM adapter"
```

---

### Task 10: `ZaloOauthStateService` (PKCE state) + `WispaceZaloTokenVerifyService`

**Files:**
- Create: `apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-oauth-state.service.ts`
- Test: `apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-oauth-state.service.spec.ts`
- Create: `apps/zalo-bot/src/modules/zalo-oauth/infrastructure/wispace/wispace-zalo-token-verify.service.ts`
- Test: `apps/zalo-bot/src/modules/zalo-oauth/infrastructure/wispace/wispace-zalo-token-verify.service.spec.ts`

**Interfaces:**
- Consumes: `ZaloOauthStateEntity` (Task 3).
- Produces: `ZaloOauthStateService.create(codeVerifier): Promise<string>` (returns `state`), `.consume(state): Promise<string | undefined>` (returns `codeVerifier`, deletes the row, `undefined` if missing/expired); `WispaceZaloTokenVerifyService.verifyToken(token, zaloUserId): Promise<{valid: true; userId: number} | {valid: false; reason: string}>` — both consumed by Task 11's `ZaloAccountLinkService`/`ZaloOauthController`.

- [ ] **Step 1: Write the failing test for `ZaloOauthStateService`**

```typescript
// apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-oauth-state.service.spec.ts
import type { Repository } from 'typeorm';
import { ZaloOauthStateService } from './zalo-oauth-state.service';
import { ZaloOauthStateEntity } from '../../../../infrastructure/database/entities/zalo-oauth-state.entity';

function buildRepo(overrides: Partial<Repository<ZaloOauthStateEntity>> = {}) {
  return {
    save: jest.fn(),
    findOne: jest.fn(),
    delete: jest.fn(),
    ...overrides,
  } as unknown as Repository<ZaloOauthStateEntity>;
}

describe('ZaloOauthStateService', () => {
  it('creates a state row and returns a non-empty state string', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const service = new ZaloOauthStateService(buildRepo({ save }));

    const state = await service.create('verifier-123');

    expect(state.length).toBeGreaterThan(10);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ state, codeVerifier: 'verifier-123' }),
    );
  });

  it('consumes a fresh state and deletes it', async () => {
    const row = {
      state: 'state-1',
      codeVerifier: 'verifier-123',
      createdAt: new Date(),
    };
    const findOne = jest.fn().mockResolvedValue(row);
    const del = jest.fn().mockResolvedValue(undefined);
    const service = new ZaloOauthStateService(
      buildRepo({ findOne, delete: del }),
    );

    const codeVerifier = await service.consume('state-1');

    expect(codeVerifier).toBe('verifier-123');
    expect(del).toHaveBeenCalledWith({ state: 'state-1' });
  });

  it('returns undefined for an expired state (older than 10 minutes)', async () => {
    const row = {
      state: 'state-1',
      codeVerifier: 'verifier-123',
      createdAt: new Date(Date.now() - 11 * 60 * 1000),
    };
    const findOne = jest.fn().mockResolvedValue(row);
    const del = jest.fn().mockResolvedValue(undefined);
    const service = new ZaloOauthStateService(
      buildRepo({ findOne, delete: del }),
    );

    const codeVerifier = await service.consume('state-1');

    expect(codeVerifier).toBeUndefined();
    expect(del).toHaveBeenCalledWith({ state: 'state-1' });
  });

  it('returns undefined when the state does not exist', async () => {
    const findOne = jest.fn().mockResolvedValue(null);
    const service = new ZaloOauthStateService(buildRepo({ findOne }));

    await expect(service.consume('missing')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx turbo run test --filter=@wispace/zalo-bot -- zalo-oauth-state.service`
Expected: FAIL with "Cannot find module './zalo-oauth-state.service'"

- [ ] **Step 3: Implement `ZaloOauthStateService`**

```typescript
// apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-oauth-state.service.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { Repository } from 'typeorm';
import { ZaloOauthStateEntity } from '../../../../infrastructure/database/entities/zalo-oauth-state.entity';

const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * PKCE code_verifier staging between GET /zalo/oauth/authorize and
 * GET /zalo/oauth/callback (spec §5.2). TTL enforced in application code —
 * see docs/superpowers/specs/2026-07-20-zalo-bot-mvp-design.md §11.8 for
 * the future cleanup-cron follow-up.
 */
@Injectable()
export class ZaloOauthStateService {
  constructor(
    @InjectRepository(ZaloOauthStateEntity)
    private readonly repo: Repository<ZaloOauthStateEntity>,
  ) {}

  async create(codeVerifier: string): Promise<string> {
    const state = randomBytes(24).toString('hex');
    await this.repo.save({
      state,
      codeVerifier,
      createdAt: new Date(),
    });
    return state;
  }

  /** Deletes the row regardless of outcome (single-use, even if expired). */
  async consume(state: string): Promise<string | undefined> {
    const row = await this.repo.findOne({ where: { state } });
    if (!row) {
      return undefined;
    }

    await this.repo.delete({ state });

    const isExpired = Date.now() - row.createdAt.getTime() > STATE_TTL_MS;
    return isExpired ? undefined : row.codeVerifier;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx turbo run test --filter=@wispace/zalo-bot -- zalo-oauth-state.service`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the failing test for `WispaceZaloTokenVerifyService`**

```typescript
// apps/zalo-bot/src/modules/zalo-oauth/infrastructure/wispace/wispace-zalo-token-verify.service.spec.ts
import { ConfigService } from '@nestjs/config';
import { WispaceZaloTokenVerifyService } from './wispace-zalo-token-verify.service';

function buildConfig(): ConfigService {
  return {
    get: (key: string) =>
      ({
        WISPACE_API_VERIFY_TOKEN_URL: 'https://wispace.example.com/verify-token-url',
        WISPACE_INTERNAL_KEY: 'internal-key-1',
      })[key],
  } as unknown as ConfigService;
}

describe('WispaceZaloTokenVerifyService', () => {
  it('returns valid:true with userId on success', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ userId: 42 }),
    });
    const service = new WispaceZaloTokenVerifyService(
      buildConfig(),
      fetchMock as any,
    );

    const result = await service.verifyToken('link-token', 'zalo-1');

    expect(result).toEqual({ valid: true, userId: 42 });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://wispace.example.com/verify-token-url',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Internal-Key': 'internal-key-1' }),
      }),
    );
    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body as string)).toEqual({
      token: 'link-token',
      value: 'zalo-1',
      platform: 'zalo',
    });
  });

  it('returns valid:false with a reason on a known failure response', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      text: async () => JSON.stringify({ reason: 'EXPIRED' }),
    });
    const service = new WispaceZaloTokenVerifyService(
      buildConfig(),
      fetchMock as any,
    );

    const result = await service.verifyToken('link-token', 'zalo-1');

    expect(result).toEqual({ valid: false, reason: 'EXPIRED' });
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx turbo run test --filter=@wispace/zalo-bot -- wispace-zalo-token-verify.service`
Expected: FAIL with "Cannot find module './wispace-zalo-token-verify.service'"

- [ ] **Step 7: Implement `WispaceZaloTokenVerifyService`**

```typescript
// apps/zalo-bot/src/modules/zalo-oauth/infrastructure/wispace/wispace-zalo-token-verify.service.ts
import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type ZaloLinkVerifyFailureReason =
  | 'NOT_FOUND'
  | 'EXPIRED'
  | 'USED'
  | 'INVALID_FORMAT';

export type ZaloLinkVerifyResult =
  | { valid: true; userId: number }
  | { valid: false; reason: ZaloLinkVerifyFailureReason };

const VERIFY_FAILURE_REASONS: ZaloLinkVerifyFailureReason[] = [
  'NOT_FOUND',
  'EXPIRED',
  'USED',
  'INVALID_FORMAT',
];

/**
 * Calls WISPACE's shared account-link verify API — same
 * WISPACE_API_VERIFY_TOKEN_URL endpoint used by all 3 bots, payload
 * { token, value, platform: 'zalo' } — mirrors
 * apps/discord-bot's WispaceDiscordTokenVerifyService.
 */
@Injectable()
export class WispaceZaloTokenVerifyService {
  private readonly logger = new Logger(WispaceZaloTokenVerifyService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly httpFetch: typeof fetch = fetch,
  ) {}

  async verifyToken(
    token: string,
    zaloUserId: string,
  ): Promise<ZaloLinkVerifyResult> {
    const url = this.getVerifyUrl();
    const response = await this.httpFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': this.getInternalKey(),
      },
      body: JSON.stringify({
        token: token.trim(),
        value: zaloUserId.trim(),
        platform: 'zalo',
      }),
    });

    const text = await response.text();
    const payload: unknown = text.trim() ? JSON.parse(text) : undefined;

    if (response.ok) {
      return this.parseSuccessPayload(payload);
    }

    const failure = this.parseFailurePayload(payload);
    if (failure) {
      return failure;
    }

    throw new InternalServerErrorException(
      `WISPACE verify-zalo-token failed: HTTP ${response.status}`,
    );
  }

  private getVerifyUrl(): string {
    const url = this.configService
      .get<string>('WISPACE_API_VERIFY_TOKEN_URL')
      ?.trim();
    if (!url) {
      throw new InternalServerErrorException(
        'WISPACE_API_VERIFY_TOKEN_URL must be set in .env',
      );
    }
    return url;
  }

  private getInternalKey(): string {
    const key = this.configService.get<string>('WISPACE_INTERNAL_KEY')?.trim();
    if (!key) {
      throw new InternalServerErrorException(
        'WISPACE_INTERNAL_KEY must be set in .env',
      );
    }
    return key;
  }

  private parseSuccessPayload(payload: unknown): ZaloLinkVerifyResult {
    if (!payload || typeof payload !== 'object') {
      throw new InternalServerErrorException(
        'WISPACE verify-zalo-token returned invalid JSON body',
      );
    }
    const record = payload as Record<string, unknown>;
    const userId = Number(record.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      throw new InternalServerErrorException(
        'WISPACE verify-zalo-token missing userId in success response',
      );
    }
    this.logger.log(`WISPACE verify-zalo-token OK userId=${userId}`);
    return { valid: true, userId };
  }

  private parseFailurePayload(
    payload: unknown,
  ): ZaloLinkVerifyResult | undefined {
    if (!payload || typeof payload !== 'object') {
      return undefined;
    }
    const record = payload as Record<string, unknown>;
    const reason = record.reason ?? record.error;
    if (typeof reason !== 'string') {
      return undefined;
    }
    const normalized = reason.trim().toUpperCase();
    const matched = VERIFY_FAILURE_REASONS.find((r) => r === normalized);
    return matched ? { valid: false, reason: matched } : undefined;
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx turbo run test --filter=@wispace/zalo-bot -- wispace-zalo-token-verify.service`
Expected: PASS (2 tests)

- [ ] **Step 9: Commit**

```bash
git add apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-oauth-state.service.ts apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-oauth-state.service.spec.ts apps/zalo-bot/src/modules/zalo-oauth/infrastructure
git commit -m "feat(zalo-bot): add PKCE state store and WISPACE token-verify client"
```

---

### Task 11: `ZaloAccountLinkService`

**Files:**
- Create: `apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-account-link.service.ts`
- Test: `apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-account-link.service.spec.ts`

**Interfaces:**
- Consumes: `ZaloAccountLinkEntity` (Task 3), PKCE `code_challenge` generation.
- Produces: `ZaloAccountLinkService.buildPkcePair(): { codeVerifier: string; codeChallenge: string }`, `.exchangeCodeForZaloUser(code, codeVerifier): Promise<{ id: string; name: string }>`, `.upsertLink(userId, zaloUserId): Promise<void>`, `.findUserIdByZaloId(zaloUserId): Promise<number | undefined>` — consumed by Task 13's `ZaloOauthController`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-account-link.service.spec.ts
import { createHash } from 'crypto';
import { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import { ZaloAccountLinkService } from './zalo-account-link.service';
import { ZaloAccountLinkEntity } from '../../../../infrastructure/database/entities/zalo-account-link.entity';

function base64url(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function buildConfig(): ConfigService {
  return {
    getOrThrow: (key: string) =>
      ({ ZALO_APP_ID: 'app-1', ZALO_APP_SECRET_KEY: 'secret-1' })[key],
  } as unknown as ConfigService;
}

describe('ZaloAccountLinkService', () => {
  it('builds a PKCE pair where code_challenge = base64url(sha256(code_verifier))', () => {
    const service = new ZaloAccountLinkService(
      buildConfig(),
      {} as unknown as Repository<ZaloAccountLinkEntity>,
      jest.fn() as any,
    );

    const { codeVerifier, codeChallenge } = service.buildPkcePair();

    const expected = base64url(
      createHash('sha256').update(codeVerifier).digest(),
    );
    expect(codeChallenge).toBe(expected);
  });

  it('exchanges an authorization code for the Zalo user id/name', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'user-token-1' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ error: 0, id: 'zalo-user-1', name: 'Nguyen Van A' }),
      });

    const service = new ZaloAccountLinkService(
      buildConfig(),
      {} as unknown as Repository<ZaloAccountLinkEntity>,
      fetchMock as any,
    );

    const user = await service.exchangeCodeForZaloUser('auth-code', 'verifier-1');

    expect(user).toEqual({ id: 'zalo-user-1', name: 'Nguyen Van A' });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://oauth.zaloapp.com/v4/access_token',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('https://graph.zalo.me/v2.0/me'),
      expect.objectContaining({
        headers: expect.objectContaining({ access_token: 'user-token-1' }),
      }),
    );
  });

  it('upserts a link and looks it up by zaloUserId', async () => {
    const manager = { query: jest.fn().mockResolvedValue(undefined) };
    const repo = {
      manager: { transaction: (fn: any) => fn(manager) },
      findOne: jest.fn().mockResolvedValue({ userId: 42 }),
    } as unknown as Repository<ZaloAccountLinkEntity>;

    const service = new ZaloAccountLinkService(
      buildConfig(),
      repo,
      jest.fn() as any,
    );

    await service.upsertLink(42, 'zalo-user-1');
    expect(manager.query).toHaveBeenCalledTimes(2);

    const userId = await service.findUserIdByZaloId('zalo-user-1');
    expect(userId).toBe(42);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx turbo run test --filter=@wispace/zalo-bot -- zalo-account-link.service`
Expected: FAIL with "Cannot find module './zalo-account-link.service'"

- [ ] **Step 3: Implement `ZaloAccountLinkService`**

```typescript
// apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-account-link.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'crypto';
import { Repository } from 'typeorm';
import { ZaloAccountLinkEntity } from '../../../../infrastructure/database/entities/zalo-account-link.entity';

const PLATFORM = 'zalo' as const;
const ZALO_TOKEN_ENDPOINT = 'https://oauth.zaloapp.com/v4/access_token';
const ZALO_ME_ENDPOINT = 'https://graph.zalo.me/v2.0/me';

class ZaloOauthError extends Error {}

function base64url(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Zalo Login OAuth (PKCE) + account-linking to WISPACE userId — Zalo
 * counterpart to apps/discord-bot's DiscordAccountLinkService. Zalo Login
 * requires PKCE, unlike Discord's plain OAuth2 (spec §5.2).
 */
@Injectable()
export class ZaloAccountLinkService {
  private readonly logger = new Logger(ZaloAccountLinkService.name);

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(ZaloAccountLinkEntity)
    private readonly repo: Repository<ZaloAccountLinkEntity>,
    private readonly httpFetch: typeof fetch = fetch,
  ) {}

  buildPkcePair(): { codeVerifier: string; codeChallenge: string } {
    const codeVerifier = base64url(randomBytes(32));
    const codeChallenge = base64url(
      createHash('sha256').update(codeVerifier).digest(),
    );
    return { codeVerifier, codeChallenge };
  }

  async exchangeCodeForZaloUser(
    code: string,
    codeVerifier: string,
  ): Promise<{ id: string; name: string }> {
    const appId = this.configService.getOrThrow<string>('ZALO_APP_ID');
    const secretKey = this.configService.getOrThrow<string>(
      'ZALO_APP_SECRET_KEY',
    );

    const tokenResponse = await this.httpFetch(ZALO_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        secret_key: secretKey,
      },
      body: new URLSearchParams({
        code,
        app_id: appId,
        grant_type: 'authorization_code',
        code_verifier: codeVerifier,
      }),
    });

    if (!tokenResponse.ok) {
      throw new ZaloOauthError(
        `Zalo token exchange failed: ${tokenResponse.status}`,
      );
    }

    const tokenJson = (await tokenResponse.json()) as { access_token: string };

    const userResponse = await this.httpFetch(
      `${ZALO_ME_ENDPOINT}?fields=id,name`,
      { headers: { access_token: tokenJson.access_token } },
    );

    if (!userResponse.ok) {
      throw new ZaloOauthError(
        `Zalo user fetch failed: ${userResponse.status}`,
      );
    }

    const userJson = (await userResponse.json()) as {
      id: string;
      name: string;
    };
    return { id: userJson.id, name: userJson.name };
  }

  async upsertLink(userId: number, zaloUserId: string): Promise<void> {
    await this.repo.manager.transaction(async (em) => {
      await em.query(
        `DELETE FROM zalo_account_links WHERE platform = $1 AND user_id = $2 AND external_user_id != $3`,
        [PLATFORM, userId, zaloUserId],
      );
      await em.query(
        `
          INSERT INTO zalo_account_links (platform, external_user_id, user_id)
          VALUES ($1, $2, $3)
          ON CONFLICT (platform, external_user_id)
          DO UPDATE SET user_id = EXCLUDED.user_id, linked_at = now()
        `,
        [PLATFORM, zaloUserId, userId],
      );
    });

    this.logger.log(`Linked Zalo account zaloUserId=${zaloUserId} userId=${userId}`);
  }

  async findUserIdByZaloId(zaloUserId: string): Promise<number | undefined> {
    const row = await this.repo.findOne({
      where: { platform: PLATFORM, externalUserId: zaloUserId },
      select: { userId: true },
    });
    return row?.userId;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx turbo run test --filter=@wispace/zalo-bot -- zalo-account-link.service`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-account-link.service.ts apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-account-link.service.spec.ts
git commit -m "feat(zalo-bot): add Zalo Login PKCE account-link service"
```

---

### Task 12: `ZaloChatService` (webhook → agent → outbound orchestration)

**Files:**
- Create: `apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-chat.service.ts`
- Test: `apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-chat.service.spec.ts`

**Interfaces:**
- Consumes: `ZaloAgentService.reply()` (Task 9), `ZaloOutboundService.sendText()` (Task 7), `ZaloAccountLinkService.findUserIdByZaloId()` (Task 11).
- Produces: `ZaloChatService` implementing `ZaloWebhookHandler` (`handleIncomingMessage`, `handleFollow`) from Task 6 — wired into `ZaloWebhookModule` in Task 13.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-chat.service.spec.ts
import { ZaloChatService } from './zalo-chat.service';
import { ZaloAgentService } from '../agent/zalo-agent.service';
import { ZaloOutboundService } from './zalo-outbound.service';
import { ZaloAccountLinkService } from '../../../zalo-oauth/application/services/zalo-account-link.service';

describe('ZaloChatService', () => {
  it('resolves userId, calls the agent, and sends the reply back', async () => {
    const findUserIdByZaloId = jest.fn().mockResolvedValue(42);
    const reply = jest.fn().mockResolvedValue({ text: 'Xin chào!' });
    const sendText = jest.fn().mockResolvedValue(undefined);

    const service = new ZaloChatService(
      { reply } as unknown as ZaloAgentService,
      { sendText } as unknown as ZaloOutboundService,
      { findUserIdByZaloId } as unknown as ZaloAccountLinkService,
    );

    await service.handleIncomingMessage('zalo-1', 'chào bạn');

    expect(findUserIdByZaloId).toHaveBeenCalledWith('zalo-1');
    expect(reply).toHaveBeenCalledWith({
      zaloUserId: 'zalo-1',
      userId: 42,
      userText: 'chào bạn',
    });
    expect(sendText).toHaveBeenCalledWith('zalo-1', 'Xin chào!');
  });

  it('falls back to an error message when the agent throws', async () => {
    const findUserIdByZaloId = jest.fn().mockResolvedValue(undefined);
    const reply = jest.fn().mockRejectedValue(new Error('LLM down'));
    const sendText = jest.fn().mockResolvedValue(undefined);

    const service = new ZaloChatService(
      { reply } as unknown as ZaloAgentService,
      { sendText } as unknown as ZaloOutboundService,
      { findUserIdByZaloId } as unknown as ZaloAccountLinkService,
    );

    await service.handleIncomingMessage('zalo-1', 'chào bạn');

    expect(sendText).toHaveBeenCalledWith(
      'zalo-1',
      expect.stringContaining('sự cố'),
    );
  });

  it('sends a welcome message on follow', async () => {
    const sendText = jest.fn().mockResolvedValue(undefined);
    const service = new ZaloChatService(
      {} as unknown as ZaloAgentService,
      { sendText } as unknown as ZaloOutboundService,
      {} as unknown as ZaloAccountLinkService,
    );

    await service.handleFollow('zalo-1');

    expect(sendText).toHaveBeenCalledWith(
      'zalo-1',
      expect.stringContaining('WISPACE'),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx turbo run test --filter=@wispace/zalo-bot -- zalo-chat.service`
Expected: FAIL with "Cannot find module './zalo-chat.service'"

- [ ] **Step 3: Implement `ZaloChatService`**

```typescript
// apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-chat.service.ts
import { Injectable, Logger } from '@nestjs/common';
import type { ZaloWebhookHandler } from '../../../zalo-webhook/presentation/controllers/zalo-webhook.controller';
import { ZaloAgentService } from '../agent/zalo-agent.service';
import { ZaloOutboundService } from './zalo-outbound.service';
import { ZaloAccountLinkService } from '../../../zalo-oauth/application/services/zalo-account-link.service';

const FALLBACK_ERROR_MESSAGE =
  'Xin lỗi, mình gặp sự cố khi xử lý tin nhắn. Bạn thử lại sau ít phút nhé.';

const WELCOME_MESSAGE =
  'Chào bạn! Mình là trợ lý học tập WISPACE. Bạn có thể hỏi mình bất cứ điều gì, và nhắn "liên kết" để kết nối tài khoản WISPACE nhé 🎓';

/**
 * Orchestrates webhook message → account-link lookup → LLM agent →
 * outbound reply. Handles each message immediately, no debounce
 * (spec §4/Global Constraints).
 */
@Injectable()
export class ZaloChatService implements ZaloWebhookHandler {
  private readonly logger = new Logger(ZaloChatService.name);

  constructor(
    private readonly agentService: ZaloAgentService,
    private readonly outboundService: ZaloOutboundService,
    private readonly accountLinkService: ZaloAccountLinkService,
  ) {}

  async handleIncomingMessage(zaloUserId: string, text: string): Promise<void> {
    try {
      const userId = await this.accountLinkService.findUserIdByZaloId(
        zaloUserId,
      );
      const reply = await this.agentService.reply({
        zaloUserId,
        userId,
        userText: text,
      });
      await this.outboundService.sendText(zaloUserId, reply.text);
    } catch (error) {
      this.logger.error(
        `Chat reply failed for zaloUserId=${zaloUserId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await this.outboundService.sendText(zaloUserId, FALLBACK_ERROR_MESSAGE);
    }
  }

  async handleFollow(zaloUserId: string): Promise<void> {
    await this.outboundService.sendText(zaloUserId, WELCOME_MESSAGE);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx turbo run test --filter=@wispace/zalo-bot -- zalo-chat.service`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-chat.service.ts apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-chat.service.spec.ts
git commit -m "feat(zalo-bot): add ZaloChatService orchestrator"
```

---

### Task 13: `ZaloOauthController` + final module wiring

**Files:**
- Create: `apps/zalo-bot/src/modules/zalo-oauth/presentation/controllers/zalo-oauth.controller.ts`
- Test: `apps/zalo-bot/src/modules/zalo-oauth/presentation/controllers/zalo-oauth.controller.spec.ts`
- Create: `apps/zalo-bot/src/modules/zalo-oauth/zalo-oauth.module.ts`
- Modify: `apps/zalo-bot/src/modules/zalo-webhook/zalo-webhook.module.ts` (bind `ZALO_WEBHOOK_HANDLER` to `ZaloChatService`)
- Create: `apps/zalo-bot/src/modules/zalo-chat/zalo-chat.module.ts`
- Modify: `apps/zalo-bot/src/app.module.ts` (import `ZaloOauthModule`, `ZaloChatModule`, `ZaloWebhookModule`)

**Interfaces:**
- Consumes: `ZaloAccountLinkService` (Task 11), `WispaceZaloTokenVerifyService` (Task 10), `ZaloOauthStateService` (Task 10), `ZaloOutboundService` (Task 7).
- Produces: `GET /zalo/oauth/authorize`, `GET /zalo/oauth/callback` — final piece of the account-linking flow (spec §5.2).

- [ ] **Step 1: Write the failing test for `ZaloOauthController`**

```typescript
// apps/zalo-bot/src/modules/zalo-oauth/presentation/controllers/zalo-oauth.controller.spec.ts
import { ZaloOauthController } from './zalo-oauth.controller';
import { ZaloAccountLinkService } from '../../application/services/zalo-account-link.service';
import { ZaloOauthStateService } from '../../application/services/zalo-oauth-state.service';
import { WispaceZaloTokenVerifyService } from '../../infrastructure/wispace/wispace-zalo-token-verify.service';
import { ZaloOutboundService } from '../../../zalo-chat/application/services/zalo-outbound.service';
import { ConfigService } from '@nestjs/config';

function buildConfig(): ConfigService {
  return {
    getOrThrow: (key: string) =>
      ({
        ZALO_APP_ID: 'app-1',
        ZALO_OAUTH_REDIRECT_URI: 'https://zalo-bot.example.com/zalo/oauth/callback',
      })[key],
  } as unknown as ConfigService;
}

function buildRes() {
  return { redirect: jest.fn(), json: jest.fn() } as any;
}

describe('ZaloOauthController', () => {
  it('GET /authorize redirects to Zalo Login with a code_challenge and state', async () => {
    const buildPkcePair = jest
      .fn()
      .mockReturnValue({ codeVerifier: 'verifier-1', codeChallenge: 'challenge-1' });
    const create = jest.fn().mockResolvedValue('state-1');

    const controller = new ZaloOauthController(
      buildConfig(),
      { buildPkcePair, exchangeCodeForZaloUser: jest.fn(), upsertLink: jest.fn(), findUserIdByZaloId: jest.fn() } as unknown as ZaloAccountLinkService,
      { create, consume: jest.fn() } as unknown as ZaloOauthStateService,
      { verifyToken: jest.fn() } as unknown as WispaceZaloTokenVerifyService,
      { sendText: jest.fn() } as unknown as ZaloOutboundService,
    );

    const res = buildRes();
    await controller.authorize('wispace-link-token', res);

    expect(create).toHaveBeenCalledWith('verifier-1');
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining('code_challenge=challenge-1'),
    );
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining('state=state-1'),
    );
  });

  it('GET /callback links the account and sends a welcome message on success', async () => {
    const consume = jest.fn().mockResolvedValue('verifier-1');
    const exchangeCodeForZaloUser = jest
      .fn()
      .mockResolvedValue({ id: 'zalo-user-1', name: 'A' });
    const verifyToken = jest.fn().mockResolvedValue({ valid: true, userId: 42 });
    const upsertLink = jest.fn().mockResolvedValue(undefined);
    const sendText = jest.fn().mockResolvedValue(undefined);

    const controller = new ZaloOauthController(
      buildConfig(),
      {
        buildPkcePair: jest.fn(),
        exchangeCodeForZaloUser,
        upsertLink,
        findUserIdByZaloId: jest.fn(),
      } as unknown as ZaloAccountLinkService,
      { create: jest.fn(), consume } as unknown as ZaloOauthStateService,
      { verifyToken } as unknown as WispaceZaloTokenVerifyService,
      { sendText } as unknown as ZaloOutboundService,
    );

    const res = buildRes();
    await controller.callback('auth-code', 'wispace-link-token', 'state-1', res);

    expect(consume).toHaveBeenCalledWith('state-1');
    expect(exchangeCodeForZaloUser).toHaveBeenCalledWith('auth-code', 'verifier-1');
    expect(verifyToken).toHaveBeenCalledWith('wispace-link-token', 'zalo-user-1');
    expect(upsertLink).toHaveBeenCalledWith(42, 'zalo-user-1');
    expect(sendText).toHaveBeenCalledWith(
      'zalo-user-1',
      expect.stringContaining('liên kết'),
    );
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it('GET /callback returns an error when the PKCE state is missing/expired', async () => {
    const consume = jest.fn().mockResolvedValue(undefined);

    const controller = new ZaloOauthController(
      buildConfig(),
      {
        buildPkcePair: jest.fn(),
        exchangeCodeForZaloUser: jest.fn(),
        upsertLink: jest.fn(),
        findUserIdByZaloId: jest.fn(),
      } as unknown as ZaloAccountLinkService,
      { create: jest.fn(), consume } as unknown as ZaloOauthStateService,
      { verifyToken: jest.fn() } as unknown as WispaceZaloTokenVerifyService,
      { sendText: jest.fn() } as unknown as ZaloOutboundService,
    );

    const res = buildRes();
    await controller.callback('auth-code', 'wispace-link-token', 'state-1', res);

    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: expect.stringContaining('hết hạn'),
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx turbo run test --filter=@wispace/zalo-bot -- zalo-oauth.controller`
Expected: FAIL with "Cannot find module './zalo-oauth.controller'"

- [ ] **Step 3: Implement `ZaloOauthController`**

```typescript
// apps/zalo-bot/src/modules/zalo-oauth/presentation/controllers/zalo-oauth.controller.ts
import { Controller, Get, Logger, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { ZaloAccountLinkService } from '../../application/services/zalo-account-link.service';
import { ZaloOauthStateService } from '../../application/services/zalo-oauth-state.service';
import { WispaceZaloTokenVerifyService } from '../../infrastructure/wispace/wispace-zalo-token-verify.service';
import { ZaloOutboundService } from '../../../zalo-chat/application/services/zalo-outbound.service';

const LINK_WELCOME_MESSAGE =
  'Tài khoản WISPACE của bạn đã liên kết thành công với Zalo! 🎉';

@Controller('zalo/oauth')
export class ZaloOauthController {
  private readonly logger = new Logger(ZaloOauthController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly accountLinkService: ZaloAccountLinkService,
    private readonly oauthStateService: ZaloOauthStateService,
    private readonly tokenVerifyService: WispaceZaloTokenVerifyService,
    private readonly outboundService: ZaloOutboundService,
  ) {}

  /** `token` is WISPACE's own link token, passed through as-is (WISPACE owns its expiry/usage state). */
  @Get('authorize')
  async authorize(
    @Query('token') linkToken: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const appId = this.configService.getOrThrow<string>('ZALO_APP_ID');
    const redirectUri = this.configService.getOrThrow<string>(
      'ZALO_OAUTH_REDIRECT_URI',
    );

    const { codeVerifier, codeChallenge } =
      this.accountLinkService.buildPkcePair();
    const state = await this.oauthStateService.create(codeVerifier);

    const url = new URL('https://oauth.zaloapp.com/v4/permission');
    url.searchParams.set('app_id', appId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('state', `${state}:${linkToken ?? ''}`);

    res.redirect(url.toString());
  }

  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('token') linkTokenFallback: string | undefined,
    @Query('state') rawState: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (!code || !rawState) {
      res.json({ success: false, message: 'Thiếu code hoặc state.' });
      return;
    }

    const [state, linkTokenFromState] = rawState.split(':');
    const linkToken = linkTokenFromState || linkTokenFallback;

    const codeVerifier = await this.oauthStateService.consume(state);
    if (!codeVerifier || !linkToken) {
      res.json({
        success: false,
        message: 'Link đã hết hạn hoặc không hợp lệ, vui lòng thử lại.',
      });
      return;
    }

    try {
      const zaloUser = await this.accountLinkService.exchangeCodeForZaloUser(
        code,
        codeVerifier,
      );

      const verifyResult = await this.tokenVerifyService.verifyToken(
        linkToken,
        zaloUser.id,
      );
      if (!verifyResult.valid) {
        res.json({
          success: false,
          message: 'Link đã hết hạn hoặc không hợp lệ, vui lòng thử lại.',
        });
        return;
      }

      await this.accountLinkService.upsertLink(verifyResult.userId, zaloUser.id);
      await this.outboundService.sendText(zaloUser.id, LINK_WELCOME_MESSAGE);

      res.json({ success: true });
    } catch (error) {
      this.logger.error(
        `Zalo OAuth callback failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      res.json({ success: false, message: 'Có lỗi xảy ra, vui lòng thử lại.' });
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx turbo run test --filter=@wispace/zalo-bot -- zalo-oauth.controller`
Expected: PASS (3 tests)

- [ ] **Step 5: Create `ZaloOauthModule`**

```typescript
// apps/zalo-bot/src/modules/zalo-oauth/zalo-oauth.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ZaloOaTokenEntity } from '../../infrastructure/database/entities/zalo-oa-token.entity';
import { ZaloOauthStateEntity } from '../../infrastructure/database/entities/zalo-oauth-state.entity';
import { ZaloAccountLinkEntity } from '../../infrastructure/database/entities/zalo-account-link.entity';
import { ZaloTokenService } from './application/services/zalo-token.service';
import { ZaloTokenRefreshService } from './application/services/zalo-token-refresh.service';
import { ZaloOauthStateService } from './application/services/zalo-oauth-state.service';
import { ZaloAccountLinkService } from './application/services/zalo-account-link.service';
import { WispaceZaloTokenVerifyService } from './infrastructure/wispace/wispace-zalo-token-verify.service';
import { ZaloOauthController } from './presentation/controllers/zalo-oauth.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ZaloOaTokenEntity,
      ZaloOauthStateEntity,
      ZaloAccountLinkEntity,
    ]),
  ],
  controllers: [ZaloOauthController],
  providers: [
    ZaloTokenService,
    ZaloTokenRefreshService,
    ZaloOauthStateService,
    ZaloAccountLinkService,
    WispaceZaloTokenVerifyService,
  ],
  exports: [ZaloTokenService, ZaloAccountLinkService],
})
export class ZaloOauthModule {}
```

- [ ] **Step 6: Create `ZaloChatModule` (single-provider LLM adapter — no failover in this MVP, see Note below)**

```typescript
// apps/zalo-bot/src/modules/zalo-chat/zalo-chat.module.ts
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createLlmProviderAdapter, type LlmProviderAdapter } from '@wispace/llm-agent';
import { ZaloOauthModule } from '../zalo-oauth/zalo-oauth.module';
import { ZaloAgentService } from './application/agent/zalo-agent.service';
import { ZaloAgentToolsService } from './application/agent/zalo-agent-tools.service';
import { ZaloChatHistoryService } from './application/services/zalo-chat-history.service';
import { ZaloOutboundService } from './application/services/zalo-outbound.service';
import { ZaloChatService } from './application/services/zalo-chat.service';

@Module({
  imports: [ZaloOauthModule],
  providers: [
    {
      provide: 'LLM_PROVIDER_ADAPTER',
      useFactory: (configService: ConfigService): LlmProviderAdapter =>
        createLlmProviderAdapter({
          getApiKey: () =>
            configService.get<string>('OPENAI_API_KEY')?.trim() || undefined,
          getModel: () =>
            configService.get<string>('OPENAI_MODEL')?.trim() || 'gpt-5.4',
          provider: 'openai',
        }),
      inject: [ConfigService],
    },
    ZaloAgentService,
    ZaloAgentToolsService,
    ZaloChatHistoryService,
    ZaloOutboundService,
    ZaloChatService,
  ],
  exports: [ZaloChatService, ZaloOutboundService],
})
export class ZaloChatModule {}
```

**Note (future work):** no multi-provider failover here — if `apps/zalo-bot` later needs it, copy the `LLM_PROVIDER_FAILOVER_ORDER` factory from `apps/discord-bot/src/modules/discord-chat/discord-chat.module.ts` (see also `discord-chat-factory.spec.ts` for its test pattern).

- [ ] **Step 7: Update `ZaloWebhookModule` to bind the real handler**

```typescript
// apps/zalo-bot/src/modules/zalo-webhook/zalo-webhook.module.ts
import { Module } from '@nestjs/common';
import { ZaloChatModule } from '../zalo-chat/zalo-chat.module';
import { ZaloChatService } from '../zalo-chat/application/services/zalo-chat.service';
import {
  ZALO_WEBHOOK_HANDLER,
  ZaloWebhookController,
} from './presentation/controllers/zalo-webhook.controller';

@Module({
  imports: [ZaloChatModule],
  controllers: [ZaloWebhookController],
  providers: [
    { provide: ZALO_WEBHOOK_HANDLER, useExisting: ZaloChatService },
  ],
})
export class ZaloWebhookModule {}
```

- [ ] **Step 8: Wire everything into `AppModule`**

```typescript
// apps/zalo-bot/src/app.module.ts — final imports array
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { HealthController } from './health.controller';
import { DatabaseModule } from './infrastructure/database/database.module';
import { ZaloOauthModule } from './modules/zalo-oauth/zalo-oauth.module';
import { ZaloChatModule } from './modules/zalo-chat/zalo-chat.module';
import { ZaloWebhookModule } from './modules/zalo-webhook/zalo-webhook.module';

@Module({
  controllers: [HealthController],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env.shared'],
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    ZaloOauthModule,
    ZaloChatModule,
    ZaloWebhookModule,
  ],
})
export class AppModule {}
```

- [ ] **Step 9: Run the full test + build + lint + typecheck suite for the app**

Run: `npx turbo run format:check lint typecheck test build --filter=@wispace/zalo-bot`
Expected: all pass (all tests written in Tasks 1–13 green, no TypeScript errors, no lint errors).

- [ ] **Step 10: Add the shared verify-token URL section reference and commit**

```bash
git add apps/zalo-bot/src/modules apps/zalo-bot/src/app.module.ts
git commit -m "feat(zalo-bot): wire ZaloOauthController and final module graph"
```

---

## Post-Plan Verification

After Task 13, run the full cross-app verify to confirm nothing else broke:

```bash
npx turbo run format:check lint typecheck test build --filter=@wispace/messenger-bot... --filter=@wispace/zalo-bot...
```

Expected: all green. This closes out the MVP scope from `docs/superpowers/specs/2026-07-20-zalo-bot-mvp-design.md` §§2–7 (webhook, OA token lifecycle, account-linking, chat via LLM agent, stub tools). Real WISPACE tools, quota, ZNS, and the rest of §11's future work remain out of scope — track them as separate specs/plans when picked up.
