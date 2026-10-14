# AGENTS.md

Working notes for AI agents in **wispace-bots** — a Turborepo monorepo of WISPACE
student bots (progress reports, study-session reminders, rate-limited AI chat).
Three deployable bots over one shared PostgreSQL schema (`ai_chat_bot_db`) plus
shared packages in `packages/`. NestJS 12, TypeORM, Redis, LLM provider adapters.
Backend service: API surfaces, crons, workers — no UI, no microservice split.

Paths are written for `apps/messenger-bot/`: run its `npm run …` scripts there, or
`npx turbo run <script> --filter=@wispace/messenger-bot...` from the root.

This file is the **router** plus the invariants that hold for every task. Read a
pointed-at file when its trigger matches, not preemptively. Review-time judgement
lives in `CODING_STANDARDS.md`; the detail layer is `docs/`.

---

## Invariants (every task)

**Fail-closed startup.** Configuration the app would refuse to boot on is judged
before the process exists: `bootstrapBot` runs `loadVaultSecrets`, then
`validateInternalApiKeyEnv` — a missing or too-short `INTERNAL_API_KEY` aborts
startup, and it cannot be a `ConfigModule.forRoot({ validate })` hook, which runs
at import time, before Vault, and would read a Vault-delivered key as missing —
then `NestFactory.create`. Ops endpoints stay behind `InternalApiKeyGuard`. Add a
startup constraint by **extending a collector**, never by editing a deploy script.
Startup rejects rather than degrades on: PostgreSQL TLS for a non-local host
(`DB_ALLOW_INSECURE_HOSTS` is the only plaintext exception), WISPACE upstream URL
policy, Zalo OA token encryption, an unsupported production `CHAT_BURST_STORE`, and
a report producer concurrency above computed capacity.

**Masked identity, no secrets in context.** External ids (Messenger PSID, Discord
id, Zalo id, WISPACE `userId`) reach logs, thrown errors and persisted error strings
only through `maskExternalId` / `maskEventId`; link-token material stays out of logs
entirely. `RedactedLogger` masks long digit runs in every line regardless. Prompt,
tool schema and tool results are a **no-secrets zone**: `redactSecrets` runs inside
the sanitizers, and a stored turn is re-sanitized on every replay, never trusted
because it "passed once". The process canary rides as the data-only
`Process marker: <value>` part and never enters logs, history, events or metrics.
Guards: `.github/scripts/check-log-redaction.js`. Rule + credential registry:
`docs/agent-redaction.md`.

**One home per meaning.** A cross-context type is declared once in
`@wispace/contracts` — ADR-0043's test: a cause taxonomy a deciding, an applying and
a recording context all read is cross-context; a state private to one context's own
rows stays with that context. Platform storage literals live in `PLATFORM_STORAGE`
(ADR-0042). Advisory lock ownership follows platform boundaries: Messenger-local
ids live in `ADVISORY_LOCK`; shared and Discord/Zalo ids live in `ADVISORY_LOCKS`.
Chat wiring goes through
`createPlatformChatProviders`: the factory selects no implementation by platform,
and every agent option is present, `null` meaning "this bot has no such hook".
Persistence: `packages/database` owns schema/entities/migrations; adapters come from
`@wispace/scheduler-core/adapters` and `@wispace/reschedule-confirm/adapters`.
Full map: `docs/architecture-boundaries.md`.

**Claimed work is leased.** Every cron- or retry-claimable row carries a
`lease_token` + `lease_expires_at`; completion requires that token, recovery reopens
expired leases only, and the stuck threshold stays above the lease
(`resetStuckProcessingJobs` uses `2 × leaseMs`). Durable inboxes persist before the
endpoint acknowledges. Registry, mutation proof, cached reads and erasure:
`docs/agent-state-and-recovery.md`.

**Prompts are composed, not duplicated.** Universal chat rules live once in
`CHAT_SYSTEM_PROMPT_CORE` (`packages/llm-agent/src/chat-system-prompt.ts`);
platform rules live in each `apps/*/src/shared/prompts/*-chat.system.txt`. A tool's
schema `description` is its primary guidance surface. Editing a prompt requires
`npm run build` and re-validates the eval fixture hashes — see `docs/agent-llm-and-chat.md`.

**Identity headers.** WISPACE calls carry the platform identity header (`x-psid`
Messenger, `x-discordid` Discord, `x-zaloid` Zalo) plus `X-Internal-Key`
(`WISPACE_INTERNAL_KEY`). Zalo interactive tools send the **inbound** Zalo OA id;
the internal WISPACE `userId` stays local. Mapping linkage requires
`POST WISPACE_API_VERIFY_TOKEN_URL` (`MESSENGER_LINK_MODE=token`), and startup fails
if that config is missing.

---

## Workflow

**Implement.** Small diffs, reuse what exists, config via `ConfigService` + `.env`
with a new variable also landing in `.env.example`; required `STUDY_REMINDER_*`
values are read with `readRequiredPositiveNumber` rather than defaulted in code.
Cross-module calls go through a port (`@Inject(TOKEN)`), `import type` for
interfaces. A feature module runs `domain/ → application/ → infrastructure/ ←
presentation/`. Outbox tables plus advisory locks serve where a broker would
(Bull, SQS, a Redis queue) — a new broker needs an ADR. User-facing text is
Vietnamese; logs and comments English, or short Vietnamese where the logic is not
self-evident.

_Done when:_ the change compiles in the layer it belongs to and each rule it
touches has one authoritative home.

**Verify.**

```bash
npm run verify            # full gate — root-owned definition in scripts/verify.mjs
npm run verify:affected   # PR variant: same root checks, Turbo tasks scoped to affected workspaces
npm run verify -- --force # uncached full pass (what the scheduled run uses)
```

Run from the repository root. `npm run format` first when only formatting moved. A
green targeted test is not a green gate. `CODING_STANDARDS.md` names the guard behind
each mechanical rule; `docs/agent-verify-gate.md` covers where a new check is wired,
what the guards cannot see, and the local-only failures (open handles, CRLF, free
RAM — `knip:deps` dies on RAM, not a heap cap).

_Done when:_ the gate exits 0 on the tree being pushed, and the guards you added or
touched have been observed failing once (`/prove-checks`).

**Report.** Use the completion checklist in `CODING_STANDARDS.md` before reporting.

---

## Router — read the row for your task

| Your task                                                 | Read                                                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Reviewing, reporting, opening a PR                        | `CODING_STANDARDS.md`                                                                                                     |
| Adding a check/guard, deploy wiring, dependency placement | `docs/agent-verify-gate.md`                                                                                               |
| Prompts, agent tools, chat wiring, evals, model context   | `docs/agent-llm-and-chat.md`, `.claude/rules/prompts.md`                                                                  |
| Log lines, untrusted text, telemetry, secrets in context  | `docs/agent-redaction.md`                                                                                                 |
| Crons, locks, leases, retries, recovery, erasure, caches  | `docs/agent-state-and-recovery.md`, `docs/privacy-erasure-verification.md`                                                |
| Module boundaries, ports, package imports, DI wiring      | `docs/architecture-boundaries.md`, `.claude/rules/clean-architecture.md`                                                  |
| Chat queue, history, burst counter, quota internals       | `.claude/rules/messenger-chat.md`, `.claude/rules/chat-rate-limit.md`, `apps/messenger-bot/docs/chat-rate-limit-quota.md` |
| Reminders, sync, dispatch, reschedule operations          | `.claude/rules/study-reminder.md`, `apps/messenger-bot/docs/study-session-reminder.md`                                    |
| Entities, migrations, schema                              | `.claude/rules/database.md`, `/typeorm-migration`                                                                         |
| Deploy, VPS, production secrets, alerts                   | `docs/project-overview.md` §12, `docs/vault-secrets.md`, `docs/monitoring-alerts.md`                                      |
| Any cross-cutting question; first time in the repo        | `docs/project-overview.md` (§2–§5 structure and flows, §9 ops scripts, §11 setup)                                         |
| Incident triage: quota, usage, readiness                  | `npm run ops:health`, `npm run chat-quota:status`, `npm run llm-usage:status`, `docs/slo-catalog.md`                      |
| Issues, triage, ADRs, domain vocabulary                   | `docs/agents/issue-tracker.md`, `docs/agents/domain.md`, `GLOSSARY.md`, `docs/adr/`                                       |
| Claude Code specifics, skills, path-scoped rules          | `CLAUDE.md`, `.claude/rules/`, `.claude/skills/`                                                                          |

---

## Open, do not assume done

`CHAT_RATE_LIMIT_ENABLED=true` still has to be set on the production env (H1).
PostgreSQL HA/failover is operator work (#408/#409). Per-app self-pull target
resolution is fleet-wide until #695. Redis-global concurrency is not claimed
fleet-fair (#867), mixed chat fairness is #580, Discord and Zalo do not yet read
the reschedule mutation-proof record (#1483), and the classifier is single-provider
until #417. Closed-gap status is `docs/edge-cases-roadmap.md`; the decision record is
`docs/adr/`.

Actions that wait for an explicit request — committing, pushing, force pushing,
git config, closing or commenting on issues, creating markdown outside `docs/` other
than the root agent files — are listed in `CODING_STANDARDS.md`.
