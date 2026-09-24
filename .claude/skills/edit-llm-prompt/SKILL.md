---
name: edit-llm-prompt
description: Edit LLM system prompts for student reports, study reminders, or the free-form chat prompt (core + per-bot overlays). Use when user asks to change report content, study reminders, LLM prompt, chat behavior/tone, or Messenger/Discord/Zalo chat messages.
---

# Edit LLM prompt

## Files

| Prompt                                                                     | Service                                                                                             | Where                                          |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `packages/llm-agent/src/chat-system-prompt.ts` (`CHAT_SYSTEM_PROMPT_CORE`) | Chat AI — universal rules (scope, untrusted calendar IDs/list-first reschedule #627, non-disclosure of internals #625, no-tool, no-fabrication, precreate, general) shared by all 3 bots | TS module — packages do not ship `.txt` assets |
| `apps/messenger-bot/src/shared/prompts/messenger-chat.system.txt`          | Chat AI — Messenger overlay (identity, cards, reschedule buttons, report registration)              | Overlay of the core                            |
| `apps/discord-bot/src/shared/prompts/discord-chat.system.txt`              | Chat AI — Discord overlay (identity, DM privacy, reschedule buttons)                                | Overlay of the core                            |
| `apps/zalo-bot/src/shared/prompts/zalo-chat.system.txt`                    | Chat AI — Zalo overlay (identity, reschedule confirm)                                               | Overlay of the core                            |
| `apps/messenger-bot/src/shared/prompts/student-report.system.txt`          | Student report (Messenger)                                                                          | Standalone                                     |
| `apps/messenger-bot/src/shared/prompts/study-reminder.system.txt`          | Study reminder (Messenger)                                                                          | Standalone                                     |

Read `.claude/rules/prompts.md` before editing.

## Workflow

1. Decide where the change belongs: **core** (applies to all bots) vs **overlay** (one platform). Never duplicate a core rule into an overlay.
2. Edit the file — output targets Vietnamese bot messages.
3. `npx turbo run build --filter=@wispace/chat-agent... --filter=@wispace/messenger-bot...` (chat core) or `--filter=@wispace/messenger-bot...` (app prompt files — copies to `apps/messenger-bot/dist/shared/prompts/`).
4. **Editing `CHAT_SYSTEM_PROMPT_CORE`** also: (a) update the section-presence guards in `packages/llm-agent/src/chat-system-prompt.spec.ts` and `SYSTEM_PROMPT_LEAK_MARKERS` in `final-output.utils.ts` if you added/renamed a section; (b) run `npm run eval:rehash:check` to expose stale hashes. Keep old hashes in the behavior PR; use step 5 for the write-mode rehash after review and merge.
5. **Keep evaluator hash rewrites separate (#1238)**: do not run write-mode `npm run eval:rehash` in a behavior PR. Land the prompt/agent change first, allow the read-only guardrail battery to show the expected stale-hash red state, then rebase main and open a hash-only rehash PR with `Rehashes: #<behavior-pr>` in the body. A combined behavior plus hash PR needs the exact `eval-rehash-approved` label and a fresh current-head APPROVED review from a trusted OWNER or MEMBER who is not the author.
6. Test: bot preview menu or `POST /messenger/send-reports` with `{ "psid": "..." }` (ops key).

## Prompt canary (#1285)

- Runtime chat composition order is `core → overlay → data-only Process marker: <value> → suffix`.
- `generatePromptCanary` is a core API; new production imports use `@wispace/llm-agent/core`, not the root compatibility façade.
- The process marker is the only narrow no-secrets exception for model context. Keep it out of logs, history, safety events, metrics, alerts, configuration, and DB. Masked external IDs may follow the existing logging policy; external IDs must not enter metrics, alerts, or events.
- Existing core non-disclosure text supplies behavior. Do not add a canary rule to `CHAT_SYSTEM_PROMPT_CORE`, change its hash, or add report/reminder canaries.
- Eval uses a fixed test-only 32-hex marker; do not use runtime entropy in eval fixtures.

## Do not

- Inline long prompts into `*.service.ts`.
- Hardcode message content in service instead of prompt (except fallback when no API key).
- Edit `packages/llm-agent/src/messages.ts` (redirect/injection blocked notifications) thinking it's a prompt — this is shared TS code for all bots, not a `.system.txt` file.
