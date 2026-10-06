---
name: verify
description: >-
  Format, lint, typecheck, test, and build this Turborepo monorepo before
  finishing a task. Use when completing code changes, before commit, or when
  user asks to verify/check the build.
disable-model-invocation: true
---

# Verify

Run **after code changes** and **after updating agent docs/skills** (agent-facing docs
ship in the same commit — see `AGENTS.md` → _Workflow_ → _Implement_).

## Prerequisites

```bash
npm install
```

Run at **root** — npm workspaces resolves both `apps/*` and `packages/*`. Required if you encounter `'turbo' is not recognized` or missing deps after changing `package.json` of a workspace.

## Quality gate

Run verification from the repository root. `scripts/verify.mjs` is the single definition used by local and CI entry points.

```bash
npm run verify
```

For the pull-request lane, the same repository checks run and only affected workspace typecheck/test/build tasks are selected. CI supplies `TURBO_SCM_BASE`.

```bash
npm run verify:affected
```

The scheduled CI lane uses the full gate with Turbo caching disabled:

```bash
npm run verify -- --force
```

The gate runs repository guard tests/checks, formatting, lint, dependency checks, then workspace typecheck, tests, and builds. `verify:affected` differs only by passing `--affected` to those final Turbo tasks. Run `npm run format` before the gate when repairing formatting.

The pull-request workflow also runs database checks in disposable PostgreSQL jobs:

```bash
npm run database:bootstrap-smoke
npm run database:migration-compatibility
```

Both require `NODE_ENV=test` and a loopback `DB_HOST`; never use production credentials.

## Checks

- Edit Messenger prompt (`apps/messenger-bot/src/shared/prompts/*.system.txt`) → after `build`, verify new files in `apps/messenger-bot/dist/shared/prompts/`.
- Edit `remind_at` / schedule → `study-reminder-schedule.service.spec.ts` must pass.
- Edit `packages/llm-agent` → `agent.service.spec.ts` (in package) must pass, and `@wispace/messenger-bot` app must build/test successfully (dependency).
- **Do not** use `test:e2e` in default gate (requires PostgreSQL; e2e is outdated).

Fix all verification errors before marking the task complete. Do not commit unless the user requests it.
