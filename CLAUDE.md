# wispace-bots (Turborepo monorepo)

NestJS — WISPACE student bots (Messenger + Discord + Zalo): AI reports + study reminders + rate-limited AI chat. Turborepo monorepo — see `docs/turborepo-migration-plan.md` for the full roadmap.

## Structure

```
apps/messenger-bot/    @wispace/messenger-bot — NestJS app (fully functional)
apps/discord-bot/      @wispace/discord-bot — NestJS app (fully functional)
apps/zalo-bot/         @wispace/zalo-bot — NestJS app (fully functional)
packages/llm-agent/    @wispace/llm-agent — shared LLM function-calling orchestration, framework-agnostic
```

## Stack

NestJS 11 · TypeScript · TypeORM · PostgreSQL (`ai_chat_bot_db`, shared across bots) · Redis (optional R0–R5) · LLM Provider Abstraction (adapter pattern) · Meta Graph API · Turborepo + npm workspaces

## Common commands

From root (runs via Turborepo, filter by app when needed):

```bash
npx turbo run build
npx turbo run test --filter=@wispace/messenger-bot...
npm install --workspace=apps/messenger-bot <pkg>
```

From `apps/messenger-bot/` (same as pre-migration commands):

```bash
npm run start:dev
npm run build
npm run test
npm run migration:run
npm run study-reminder:jobs
npm run chat-quota:status
```

## Full documentation

- **[AGENTS.md](./AGENTS.md)** — cross-agent standard (Codex, Cursor, Claude)
- `docs/turborepo-migration-plan.md` — monorepo roadmap + Discord/Zalo bots, cross-platform DB, independent CI/CD
- `docs/project-overview.md` — architecture, API, cron, quota runbook (primarily about `apps/messenger-bot`)
- `apps/messenger-bot/docs/chat-rate-limit-quota.md` — rate limit V1 + H1–H7
- `docs/edge-cases-roadmap.md` — Project-wide gaps + remediation phases
- `apps/messenger-bot/docs/study-session-reminder.md` — detailed study session reminders

| Path                    | Purpose                                                             |
| ----------------------- | ------------------------------------------------------------------- |
| `.claude/settings.json` | Permissions (allow npm/git; deny `.env`, destructive git)           |
| `.claude/rules/`        | Per-module conventions — lazy-load when editing matching files      |
| `.claude/skills/`       | Workflows invoked via `/skill-name` or auto-triggered when relevant |

### Available skills

| Skill                   | When to use                                                                |
| ----------------------- | -------------------------------------------------------------------------- |
| `/study-reminder-debug` | Debug study reminder jobs, sync, dispatch                                  |
| `/typeorm-migration`    | Add/modify entities + migrations                                           |
| `/edit-llm-prompt`      | Edit `apps/messenger-bot/src/shared/prompts/*.system.txt`                  |
| `/verify`               | `format` + `verify` (lint, typecheck, test, build) before finishing a task |

Path-scoped rules auto-load when editing matching files — see Rules table below.

### Rules

- `project-conventions.md` — always loaded (general conventions)
- `clean-architecture.md` — **read when editing `apps/*/src/modules/`** (4 layers, ports, DI) — includes `packages/llm-agent` boundaries (framework-agnostic, no Nest imports)
- `chat-rate-limit.md` — `apps/messenger-bot/src/modules/chat-rate-limit/**`
- `messenger-chat.md` — `apps/messenger-bot/src/modules/messenger/application/services/messenger-chat*`
- `study-reminder.md` — `apps/messenger-bot/src/modules/study-reminder/**`
- `database.md` — `apps/messenger-bot/src/infrastructure/database/**`
- `prompts.md` — `apps/messenger-bot/src/shared/prompts/**` + `packages/llm-agent/src/messages.ts`

## Agent skills

### Issue tracker

GitHub Issues (`gh` CLI). External PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles mapped to default label names. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Do not do unless explicitly requested by user

Commit/push · add queue (Redis/Bull) · modify `.env` · force push
