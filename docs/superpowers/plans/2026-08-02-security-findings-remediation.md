# Security Findings Remediation Implementation Plan

> **For agentic workers:** Execute task-by-task with tests before production changes. Do not commit or push.

**Goal:** Remediate the actionable security findings from the incomplete Codex Security scan while preserving existing bot behavior.

> **Current-source note (2026-08-13):** This remains a historical remediation plan and does not by itself assert that findings are cleared. Current health is provided by the shared `packages/bot-common/src/health.controller.ts`; authenticated webhook dedupe/ack gating is the durable inbox in `packages/database/src/services/platform-webhook-inbound-event.service.ts`, not a Redis dedupe store. Normal image deploys are pulled by the VPS self-pull path; the reusable workflow's SSH deploy path is retained for the env-only/manual flow and uses `VPS_KNOWN_HOSTS` with strict checking.

**Architecture:** Reuse existing shared ports, stores, repositories, and configuration patterns. Fix shared root causes once, then add focused regression tests at the affected package/app boundaries. Treat deployment trust anchors and production certificates as runtime configuration, not source-controlled secrets.

**Tech Stack:** NestJS, TypeScript, TypeORM, PostgreSQL, Redis/ioredis, Jest, Docker, GitHub Actions.

## Global Constraints

- Keep the worktree free of secrets; never read, print, or modify `.env`.
- No commits or pushes.
- Follow the repository verification order: `npm ci`, `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`.
- Add migrations for schema changes and update `.env.example`/agent-facing docs when configuration changes.
- Do not claim findings are fully cleared until tests, build, and a follow-up scan/triage provide evidence.

---

### Task 1: OAuth state and callback hardening

**Files:**

- Modify: `apps/zalo-bot/src/infrastructure/database/entities/zalo-oauth-state.entity.ts`
- Modify: `packages/database/src/migrations/1751029200005-CreateZaloOauthStatesTable.ts`
- Modify: `apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-oauth-state.service.ts`
- Modify: `apps/zalo-bot/src/modules/zalo-oauth/presentation/controllers/zalo-oauth.controller.ts`
- Modify: `apps/zalo-bot/src/modules/zalo-oauth/infrastructure/wispace/wispace-zalo-token-verify.service.ts`
- Test: existing Zalo OAuth controller/state/verify specs

**Deliverable:** The WISPACE bearer token is stored server-side in the one-time OAuth state and never placed in Zalo, browser, or callback URLs; callback consumes state once, validates the stored token, and all outbound verification calls have a timeout. Require a non-empty token before allocating state and cap the input length.

---

### Task 2: Webhook and public endpoint hardening

**Files:**

- Modify: `apps/zalo-bot/src/modules/zalo-webhook/application/utils/zalo-webhook-signature.utils.ts`
- Modify: `apps/zalo-bot/src/modules/zalo-webhook/presentation/controllers/zalo-webhook.controller.ts`
- Review/modify if needed: `packages/database/src/services/platform-webhook-inbound-event.service.ts` (durable inbox replaces the former Redis webhook-dedupe path)
- Modify: `packages/bot-common/src/health.controller.ts`
- Modify: `apps/messenger-bot/src/shared/common/guards/messenger-webhook-signature.guard.ts`
- Modify: `apps/messenger-bot/src/shared/common/utils/messenger-webhook-signature.config.ts`
- Modify: `apps/messenger-bot/src/modules/messenger/application/services/messenger-webhook-startup.service.ts`
- Modify: `apps/messenger-bot/src/modules/metrics/metrics.controller.ts`
- Modify: `deploy/nginx/aiassist.aihubproduction.com.conf`
- Test: existing webhook/signature/health/metrics specs

**Deliverable:** Reject stale Zalo signatures, keep durable inbox persistence/claim failures fail closed, return generic health errors, make Messenger webhook signature verification fail closed outside tests, and protect or remove public metrics exposure.

---

### Task 3: Secure database, Redis, and deployment transport

**Files:**

- Modify: `packages/database/src/typeorm-options.ts`
- Modify: Discord/Zalo database modules and Messenger TypeORM adapter if needed
- Modify: operational DB scripts using `DB_SSL`
- Modify: `packages/bot-common/src/redis.service.ts`
- Modify: `.env.shared.example`, bot `.env.example` files, relevant runbook docs
- Modify: `.github/scripts/upload-to-vps.sh`
- Modify: `.github/scripts/ssh-deploy-vps.sh`
- Modify: `.github/workflows/deploy-bot-reusable.yml`
- Modify: Dockerfiles to preserve the lockfile and pin remote installers
- Test: shared TypeORM/Redis option specs and shell syntax checks where available

**Deliverable:** TLS verifies PostgreSQL and Redis peers when enabled, deployment SSH uses a caller-provided pinned known-hosts value and strict checking, and production images use the reviewed lock graph. No fake certificate or host-key value is added.

---

### Task 4: Queue, quota, and timeout safety

**Files:**

- Modify: `packages/chat-queue-core/src/debounce-chat-queue.ts`
- Modify: Redis chat queue store and bot queue defaults
- Modify: `packages/chat-metering/src/chat-rate-limit/postgres-burst-counter.ts`
- Modify: Redis burst fallback path
- Modify: `packages/llm-agent/src/agent.service.ts`
- Modify: `packages/reschedule-confirm/src/reschedule-confirm.service.ts`
- Test: queue, quota, agent, and reschedule specs

**Deliverable:** All queue paths have a finite default cap, in-memory maps expire without user traffic, PostgreSQL burst reservation is atomic, Redis burst/dedupe failures fail safe or use the existing fallback, and agent/stream/tool timeouts do not leave uncancelled work.

---

### Task 5: Delivery, retry, and identity correctness

**Files:**

- Modify: Zalo outbound sender
- Modify: Zalo dead-letter writer/replay cron
- Modify: `packages/chat-pipeline/src/chat-pipeline.ts`
- Modify: study-reminder repository/sync/dispatch and Discord sender
- Modify: Zalo private-data tool context/headers
- Modify: Messenger cross-platform mapping cleanup
- Modify: cancelled-job cleanup and idempotency namespace migration if confirmed by schema
- Modify: advisory lock service
- Test: affected existing specs plus one regression test per root cause

**Deliverable:** Application-level delivery errors are not marked sent, dead letters replay the stored schema, soft delivery failures refund/avoid completion, reminder retries respect schedule/terminal state, Zalo tools use the authenticated principal, cleanup stays platform-scoped, and DB runners are always released.

---

### Task 6: Verification and residual triage

**Files:**

- Modify: relevant agent-facing docs and `.env.example` files
- No source changes unless verification finds a regression

**Deliverable:** Run the exact repository verification order, inspect the diff for secrets, rerun Codex Security in smaller bounded scans, and report remaining findings that require production-only values or behavior confirmation.
