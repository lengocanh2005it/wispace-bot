# wispace-bots (Turborepo monorepo)

NestJS — WISPACE student bots (Messenger + Discord + Zalo): AI reports + study
reminders + rate-limited AI chat. Turborepo monorepo, three deployable bots over one
shared PostgreSQL schema (`ai_chat_bot_db`).

**[`AGENTS.md`](./AGENTS.md) is the shared contract**: the invariants that hold for
every task, the implement → verify → report workflow, and the router naming which
file to read for your task. Read it before changing code; this file only adds the
Claude Code surface.

## Rules (path-scoped, lazy-load)

| Rule                     | Loads when editing                                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project-conventions.md` | always                                                                                                                                                    |
| `clean-architecture.md`  | `apps/*/src/modules/` (4 layers, ports, DI) + `packages/llm-agent` boundaries + zod policy ([ADR 0010](./docs/adr/0010-adopt-zod-at-trust-boundaries.md)) |
| `chat-rate-limit.md`     | `apps/messenger-bot/src/modules/chat-rate-limit/**`                                                                                                       |
| `messenger-chat.md`      | `apps/messenger-bot/src/modules/messenger/application/services/messenger-chat*`                                                                           |
| `study-reminder.md`      | `apps/messenger-bot/src/modules/study-reminder/**`                                                                                                        |
| `database.md`            | `apps/messenger-bot/src/infrastructure/database/**`                                                                                                       |
| `prompts.md`             | `apps/*/src/shared/prompts/**`, `packages/llm-agent/src/messages.ts`                                                                                      |

## Skills

| Skill                   | When                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `/verify`               | format + full gate before reporting a change                                                                        |
| `/prove-checks`         | before claiming a test, guard or migration actually ran (`.claude/skills/prove-checks/scripts/verify-mutation.mjs`) |
| `/study-reminder-debug` | study reminder jobs, sync, dispatch                                                                                 |
| `/typeorm-migration`    | add/modify entities + migrations                                                                                    |
| `/edit-llm-prompt`      | edit report, reminder or chat prompts                                                                               |
| `/refactor-audit`       | before implementing a refactor issue: `git log -S` the string it names                                              |

## Agent docs

- `docs/agents/issue-tracker.md` — GitHub Issues (`gh`) are the tracker; external PRs are not a triage surface.
- `docs/agents/triage-labels.md` — the five canonical triage roles.
- `docs/agents/domain.md` — one `CONTEXT.md` + `docs/adr/` at the repo root.
- `GLOSSARY.md` — ubiquitous language; `docs/adr/` — the decision record.

Use `CODING_STANDARDS.md` before commits, tracker changes or completion reports; it
owns gated actions and review criteria.
