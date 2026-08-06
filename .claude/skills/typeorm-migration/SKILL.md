---
name: typeorm-migration
description: Add or modify TypeORM entities and migrations for the Messenger bot (apps/messenger-bot). Use when user asks for migration, new table, schema change, entity, or database column.
disable-model-invocation: true
---

# TypeORM migration workflow

## Steps

1. Read `.claude/rules/database.md`.
2. Edit entity in `apps/messenger-bot/src/infrastructure/database/entities/`.
3. Create migration in `apps/messenger-bot/src/infrastructure/database/migrations/` with timestamp prefix (match existing files).
4. Export entity from `apps/messenger-bot/src/infrastructure/database/entities/index.ts` if new.
5. Run (trong `apps/messenger-bot/`, hoặc `npx turbo run build test --filter=@wispace/messenger-bot...` từ root):

```bash
npm run migration:run
npm run build
npm run test
```

## Constraints

- Migration bảng: mappings, logs, jobs, `users` + view `"Users"` (DB dedicated, dùng chung giữa các bot — xem `docs/turborepo-migration-plan.md` Phase 2 về generalize khóa `psid`).
- **Không** migration bảng Wispace (`UserCalendars`, `"Users"` hub, …) — cache user qua bảng `users` local.
- Cập nhật `apps/messenger-bot/.env.example` nếu thêm biến môi trường mới (không phải DB column).

## Tách DB (ops một lần — đã hoàn thành)

Prod dùng `DB_NAME=ai_chat_bot_db`; các script migrate/drop một lần đã bị xoá khỏi `scripts/`.

## Revert (cẩn thận)

```bash
npm run migration:revert
```

Chỉ khi user yêu cầu rõ — trên DB prod đang dùng (`ai_chat_bot_db`).
