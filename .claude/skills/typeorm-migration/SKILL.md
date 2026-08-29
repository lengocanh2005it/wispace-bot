---
name: typeorm-migration
description: Add or modify TypeORM entities and migrations for the Messenger bot and shared database package. Use when user asks for migration, new table, schema change, entity, or database column.
disable-model-invocation: true
---

# TypeORM migration workflow

## Steps

1. Read `.claude/rules/database.md`.
2. Edit the entity in the owning package: `packages/database/src/entities/` for shared tables, or `apps/messenger-bot/src/infrastructure/database/entities/` for Messenger-only tables.
3. Create the migration in the same owner (`packages/database/src/migrations/` or `apps/messenger-bot/src/infrastructure/database/migrations/`) with timestamp prefix (match existing files).
4. Export entity from `apps/messenger-bot/src/infrastructure/database/entities/index.ts` if new.
5. Run (trong `apps/messenger-bot/`, hoặc `npx turbo run build test --filter=@wispace/messenger-bot...` từ root):

```bash
npm run migration:run
npm run build
npm run test
```

For CI schema validation, run the root `npm run database:migration-compatibility` against disposable PostgreSQL; it exercises the canonical Messenger migration owner and checks bot tables. The separate `database:bootstrap-smoke` check intentionally uses `synchronize` and does not run migrations. Both commands require `NODE_ENV=test` with a loopback `DB_HOST` and must not target production.

## Constraints

- Migration bảng: mappings, logs, jobs, `users` + view `"Users"`, and shared durable webhook inbox/dead-letter tables (DB dedicated, dùng chung giữa các bot — xem `docs/turborepo-migration-plan.md` Phase 2 về generalize khóa `psid`).
- `webhook_inbound_events.raw_payload` and outbound dead-letter payloads are recovery data. Keep them intact for replay; mask external IDs in logs and persisted error strings. Terminal inbound rows are cleaned after `WEBHOOK_INBOUND_RETENTION_DAYS` (default 30).
- **Không** migration bảng Wispace (`UserCalendars`, `"Users"` hub, …) — cache user qua bảng `users` local.
- Cập nhật `apps/messenger-bot/.env.example` nếu thêm biến môi trường mới (không phải DB column).
- Production migrations must target the stable PostgreSQL writer endpoint. The
  shared TypeORM data source verifies `pg_is_in_recovery() = false` and guards
  `runMigrations`/`undoLastMigration` with `MIGRATION_LOCK_ID`; do not wrap the
  CLI in a separate `psql` advisory-lock shell session.
- Runtime queries use `DB_QUERY_TIMEOUT_MS`; migration CLI uses
  `DB_MIGRATION_QUERY_TIMEOUT_MS` so a long migration is not accidentally
  killed by the app query budget.
- Reschedule confirmation rows are security-sensitive: preserve the
  platform/mapping revision, intent/argument hashes, and one-time nonce
  binding; production confirmation must claim by the complete binding.

## Tách DB (ops một lần — đã hoàn thành)

Prod dùng `DB_NAME=ai_chat_bot_db`; các script migrate/drop một lần đã bị xoá khỏi `scripts/`.

## Revert (cẩn thận)

```bash
npm run migration:revert
```

Chỉ khi user yêu cầu rõ — trên DB prod đang dùng (`ai_chat_bot_db`).
