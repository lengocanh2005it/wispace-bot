---
name: edit-llm-prompt
description: Edit OpenAI system prompts for student reports or study reminders. Use when user asks to change report content, study reminders, LLM prompt, or tone of Messenger messages.
---

# Edit LLM prompt

## Files

| Prompt | Service |
|--------|---------|
| `apps/messenger-bot/src/shared/prompts/student-report.system.txt` | Student report |
| `apps/messenger-bot/src/shared/prompts/study-reminder.system.txt` | Study reminder |
| `apps/messenger-bot/src/shared/prompts/messenger-chat.system.txt` | Chat AI (function-calling via `@wispace/llm-agent`) |

Read `.Codex/rules/prompts.md` before editing.

## Workflow

1. Edit `.system.txt` — output targets Vietnamese Messenger messages.
2. `npx turbo run build --filter=@wispace/messenger-bot...` (copy to `apps/messenger-bot/dist/shared/prompts/`).
3. Test: bot preview menu or `POST /messenger/send-reports` with `{ "psid": "..." }` (ops key).

## Do not

- Inline long prompts into `*.service.ts`.
- Hardcode message content in service instead of prompt (except fallback when no API key).
- Edit `packages/llm-agent/src/messages.ts` (redirect/injection blocked notifications) thinking it's a prompt — this is shared TS code for all bots, not a `.system.txt` file.
