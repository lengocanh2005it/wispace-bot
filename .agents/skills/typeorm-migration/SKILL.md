---
name: typeorm-migration
description: Add or modify TypeORM entities and migrations for the Messenger bot (apps/messenger-bot). Use when user asks for migration, new table, schema change, entity, or database column.
disable-model-invocation: true
---

# TypeORM migration workflow

## Steps

1. Read `.Codex/rules/database.md`.
2. Edit entity in `apps/messenger-bot/src/infrastructure/database/entities/`.
3. Create migration in `apps/messenger-bot/src/infrastructure/database/migrations/` with timestamp prefix (match existing files).
4. Export entity from `apps/messenger-bot/src/infrastructure/database/entities/index.ts` if new.
5. Run (in `apps/messenger-bot/`, or `npx turbo run build test --filter=@wispace/messenger-bot...` from root):

```bash
npm run migration:run
npm run build
npm run test
```

## Constraints

- POC table migrations: mappings, logs, jobs, `users` + view `"Users"` (dedicated DB, shared across bots — see `docs/turborepo-migration-plan.md` Phase 2 for generalizing `psid` key).
- **Do not** migrate Wispace tables (`UserCalendars`, hub `"Users"`, …) — cache user data via local `users` table.
- Update `apps/messenger-bot/.env.example` if adding new environment variables (not DB columns).

## DB split (one-time ops)

Prod uses `DB_NAME=ai_chat_bot_db`. Scripts (run in `apps/messenger-bot/`):

```bash
DB_PASSWORD=... node scripts/migrate-hub-to-chat-bot-db.mjs
DB_PASSWORD=... node scripts/drop-poc-tables-old-db.mjs   # after verifying app
```

## Revert (use with caution)

```bash
npm run migration:revert
```

Only when explicitly requested — on prod DB (`ai_chat_bot_db`).
