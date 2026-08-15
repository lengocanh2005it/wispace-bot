---
name: edit-llm-prompt
description: Edit LLM system prompts for student reports, study reminders, or the free-form chat prompt (core + per-bot overlays). Use when user asks to change report content, study reminders, LLM prompt, chat behavior/tone, or Messenger/Discord/Zalo chat messages.
---

# Edit LLM prompt

## Files

| Prompt | Service | Where |
|--------|---------|-------|
| `packages/llm-agent/src/chat-system-prompt.ts` (`CHAT_SYSTEM_PROMPT_CORE`) | Chat AI — universal rules (scope, no-tool, no-fabrication, precreate, general) shared by all 3 bots | TS module — packages do not ship `.txt` assets |
| `apps/messenger-bot/src/shared/prompts/messenger-chat.system.txt` | Chat AI — Messenger overlay (identity, cards, reschedule buttons, report registration) | Overlay of the core |
| `apps/discord-bot/src/shared/prompts/discord-chat.system.txt` | Chat AI — Discord overlay (identity, DM privacy, reschedule buttons) | Overlay of the core |
| `apps/zalo-bot/src/shared/prompts/zalo-chat.system.txt` | Chat AI — Zalo overlay (identity, reschedule confirm) | Overlay of the core |
| `apps/messenger-bot/src/shared/prompts/student-report.system.txt` | Student report (Messenger) | Standalone |
| `apps/messenger-bot/src/shared/prompts/study-reminder.system.txt` | Study reminder (Messenger) | Standalone |

Read `.claude/rules/prompts.md` before editing.

## Workflow

1. Decide where the change belongs: **core** (applies to all bots) vs **overlay** (one platform). Never duplicate a core rule into an overlay.
2. Edit the file — output targets Vietnamese bot messages.
3. `npx turbo run build --filter=@wispace/chat-agent... --filter=@wispace/messenger-bot...` (chat core) or `--filter=@wispace/messenger-bot...` (app prompt files — copies to `apps/messenger-bot/dist/shared/prompts/`).
4. Test: bot preview menu or `POST /messenger/send-reports` with `{ "psid": "..." }` (ops key).

## Do not

- Inline long prompts into `*.service.ts`.
- Hardcode message content in service instead of prompt (except fallback when no API key).
- Edit `packages/llm-agent/src/messages.ts` (redirect/injection blocked notifications) thinking it's a prompt — this is shared TS code for all bots, not a `.system.txt` file.
