---
name: verify
description: >-
  Format, lint, typecheck, test, and build this Turborepo monorepo before
  finishing a task. Use when completing code changes, before commit, or when
  user asks to verify/check the build.
disable-model-invocation: true
---

# Verify (Turborepo)

Run **after code changes** and **after updating agent docs/skills** (see `AGENTS.md` → *Docs & skills when changing code*).

## Prerequisites

```bash
npm install
```

Run at **root** — npm workspaces resolves both `apps/*` and `packages/*`. Required if you encounter `'turbo' is not recognized` or missing deps after changing `package.json` of a workspace.

## Quality gate

**CI / deploy** (`.github/workflows/deploy-messenger-bot.yml`, runs only for `apps/messenger-bot`):

```bash
npx turbo run lint --filter=@wispace/messenger-bot...
npx turbo run test --filter=@wispace/messenger-bot...
npx turbo run build --filter=@wispace/messenger-bot...
```

**Full local (all workspaces):**

```bash
npx turbo run format
npx turbo run verify
```

If only editing `packages/llm-agent`: run `npx turbo run test --filter=@wispace/llm-agent` first (mock port tests, no DB/Nest needed), then re-run the `@wispace/messenger-bot...` gate (use `...` to rebuild dependent apps).

`apps/discord-bot` and `apps/zalo-bot` are currently placeholders (no-op scripts) — no need to run verify separately until real code exists (see `docs/turborepo-migration-plan.md`).

## Checks

- Edit Messenger prompt (`apps/messenger-bot/src/shared/prompts/*.system.txt`) → after `build`, verify new files in `apps/messenger-bot/dist/shared/prompts/`.
- Edit `remind_at` / schedule → `study-reminder-schedule.service.spec.ts` must pass.
- Edit `packages/llm-agent` → `agent.service.spec.ts` (in package) must pass, and `@wispace/messenger-bot` app must build/test successfully (dependency).
- **Do not** use `test:e2e` in default gate (requires PostgreSQL; e2e is outdated).

Fix all format/lint/type/test/build errors before marking task complete. Do not commit unless user requests it.
