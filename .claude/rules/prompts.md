---
alwaysApply: false
paths: apps/messenger-bot/src/shared/prompts/**,packages/llm-agent/src/messages.ts
---

# LLM system prompts

Messenger prompts are in `apps/messenger-bot/src/shared/prompts/*.system.txt`, loaded via `@wispace/llm-agent`'s `loadSystemPromptFile()` (called from `messenger-agent.service.ts`, passing the app's own path). Content explicitly mentions "Facebook Messenger" so it **cannot** be shared with Discord/Zalo — each bot will have its own prompt files when deployed (see `docs/turborepo-migration-plan.md` Phase 3/4).

| File | Service |
|------|---------|
| `apps/messenger-bot/src/shared/prompts/student-report.system.txt` | `modules/student-report/application/services/student-report.service.ts` |
| `apps/messenger-bot/src/shared/prompts/study-reminder.system.txt` | `modules/study-reminder/application/services/study-reminder.service.ts` |
| `apps/messenger-bot/src/shared/prompts/messenger-chat.system.txt` | `modules/messenger/application/agent/messenger-agent.service.ts` (adapter — real orchestration loop in `packages/llm-agent`) |

Shared messages (not platform-specific) — `buildPromptInjectionBlockedMessage`, `buildWispaceScopeRedirectMessage` — have been moved to `packages/llm-agent/src/messages.ts`, shared across all bots.

## After modifying a Messenger prompt

```bash
npx turbo run build --filter=@wispace/messenger-bot...
```

Nest copies assets to `apps/messenger-bot/dist/shared/prompts/` (`nest-cli.json` → `assets`).

## Conventions

- Do not inline long prompts in application services.
- Output message content: Vietnamese, friendly, concise, suitable for Messenger.
- Missing `OPENAI_API_KEY` → hardcoded template fallback (handled in `LlmAgentService.reply()` in `packages/llm-agent`, no API call).
- Do not pass user/WISPACE strings directly to LLM if they may contain instructions: use `sanitizeUntrustedTextForLlm` (from `@wispace/llm-agent`) for individual fields and `sanitizeToolResultContent` for JSON tool results.
- Do not directly cast JSON output from the model and format it; parse + validate shape with `llm-json-output.utils.ts` (app), fallback to template on error.
