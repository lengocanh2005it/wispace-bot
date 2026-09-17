# typecheck:tests Baseline

> Tracks `tsc -p tsconfig.json --noEmit` error counts per workspace.
> Part of [#1232](https://github.com/lengocanh2005it/wispace-bot/issues/1232) — Step 1.
>
> **How to re-measure:** `npx turbo run typecheck:tests`
>
> **Gate status:** `typecheck:tests` is NOT gated in `verify`. A workspace is folded into
> the gated `typecheck` only after its error count reaches 0 (Step 4 of #1232).

---

## Error counts

Measured on **2026-09-17** after normalizing all workspace scripts (Step 1).

| Workspace | Baseline | Current | Status |
|---|---:|---:|---|
| `apps/messenger-bot` | 80 | 76 | 🔴 errors |
| `apps/discord-bot` | 28 | 28 | 🔴 errors |
| `apps/zalo-bot` | 22 | 22 | 🔴 errors |
| `packages/bot-common` | 28 | 28 | 🔴 errors |
| `packages/llm-agent` | 19 | 0 | ✅ clean & gated |
| `packages/chat-agent` | 19 | 0 | ✅ clean & gated |
| `packages/chat-metering` | 15 | 0 | ✅ clean & gated |
| `packages/study-reminder-shared` | 14 | 0 | ✅ clean & gated |
| `packages/database` | 5 | 0 | ✅ clean & gated |
| `packages/account-link-core` | 4 | 0 | ✅ clean & gated |
| `packages/cleanup-cron` | 4 | 0 | ✅ clean & gated |
| `packages/wispace-client` | 2 | 0 | ✅ clean & gated |
| `packages/reschedule-confirm` | 2 | 0 | ✅ clean & gated |
| `packages/contracts` | 0 | 0 | ✅ clean & gated |
| `packages/chat-history` | 0 | 0 | ✅ clean & gated |
| `packages/student-report` | 0 | 0 | ✅ clean & gated |
| `packages/chat-queue-core` | 0 | 0 | ✅ clean & gated |
| `packages/chat-pipeline` | 0 | 0 | ✅ clean & gated |
| `packages/learner-profile` | 0 | 0 | ✅ clean & gated |
| `packages/scheduler-core` | 0 | 0 | ✅ clean & gated |
| `packages/bot-metrics` | 0 | 0 | ✅ clean & gated |
| `packages/ops-health` | 0 | 0 | ✅ clean & gated |
| `packages/webhook-inbound` | 0 | 0 | ✅ clean & gated |
| `packages/date-utils` | 0 | 0 | ✅ clean & gated |
| **Total** | **242** | **154** | |

---

## Already-clean workspaces (0 errors at baseline)

These 11 workspaces have no spec type errors today. Per the Step 4 plan, their
`typecheck` script already covers production code (`tsconfig.build.json`). Once the
gating contract is confirmed (i.e. `typecheck:tests` passes too), these can be
considered fully covered.

```
packages/contracts, packages/chat-history, packages/student-report,
packages/chat-queue-core, packages/chat-pipeline, packages/learner-profile,
packages/scheduler-core, packages/bot-metrics, packages/ops-health,
packages/webhook-inbound, packages/date-utils
```

---

## Genuine defects resolved

- `apps/messenger-bot` — `report-send-orchestration.service.spec.ts`: `cadence: 'weekly'` → `'WEEKLY'` (NotificationCadence case mismatch, 9 occurrences)
- `apps/messenger-bot` — `report-cron.service.spec.ts`: `psid` → `externalUserId` in `SendScheduledReportsOptions` (2 occurrences)
- `apps/messenger-bot` — `scheduler.controller.spec.ts`: fixed constructor arity (11 args vs 8)
- `apps/messenger-bot` — `study-reminder.failover.integration.spec.ts`: added required `perAttemptTimeoutMs`
- `packages/database` — `platform-link-state.service.spec.ts`: replaced ES2022 `Array.at(-1)` with index access
- `packages/database` — `platform-report-claim.repository.spec.ts`: typed queryBuilder harness & learnerQuery args
- `packages/database` — `privacy-data.service.spec.ts`: typed status as `PrivacyCleanupJobStatus` instead of literal `'pending'`

---

## Progress log

| Date | Workspace | Errors before | Errors after | PR | Notes |
|---|---|---:|---:|---|---|
| 2026-09-17 | *(Monorepo)* | — | 242 | #1232 | Step 1 complete — scripts normalized, baseline established |
| 2026-09-17 | `apps/messenger-bot` | 80 | 76 | #1232 | Fixed genuine defects: cadence case, options rename, controller arity, timeout config |
| 2026-09-17 | `packages/wispace-client` | 2 | 0 | #1232 | Fixed timeWispaceCall mock & config env types; folded into gated typecheck |
| 2026-09-17 | `packages/reschedule-confirm` | 2 | 0 | #1232 | Fixed requiresApprovalToken & rescheduleSession mock; folded into gated typecheck |
| 2026-09-17 | `packages/account-link-core` | 4 | 0 | #1232 | Fixed sleep/consumeRecord void return types & oauth-state save; folded into gated typecheck |
| 2026-09-17 | `packages/cleanup-cron` | 4 | 0 | #1232 | Fixed BuildConfigOverrides lockIds partial overrides; folded into gated typecheck |
| 2026-09-17 | `packages/database` | 5 | 0 | #1232 | Fixed Array.at, queryBuilder self-ref, tuple index, PrivacyCleanupJobStatus; folded into gated typecheck |
| 2026-09-17 | `packages/study-reminder-shared` | 14 | 0 | #1232 | Fixed Repository<AccountLinkRow> cast, claimJob args, mock method signatures; folded into gated typecheck |
| 2026-09-17 | `packages/chat-metering` | 15 | 0 | #1232 | Fixed concrete Repository mock casts, optional chaining on safety payload; folded into gated typecheck |
| 2026-09-17 | `packages/chat-agent` | 19 | 0 | #1232 | Fixed deriveAgentToolMap generic, configGet/freshMappingProvider types, clarification-state constructor; folded into gated typecheck |
| 2026-09-17 | `packages/llm-agent` | 19 | 0 | #1232 | Fixed chatWithTools request/signal type, failover-adapter async, property spec redundant branch; folded into gated typecheck |

---

## Fix order (Step 2 → 3)

Recommended order per issue #1232:

1. **Genuine-defect class first** — any `TS2820` / literal-vs-type mismatch where a test
   asserts a value the production type forbids. Start with `messenger-bot`.
2. **Smallest workspaces** — `packages/wispace-client` (2) → `packages/reschedule-confirm`
   (2) → `packages/account-link-core` (4) → `packages/cleanup-cron` (4) → `packages/database`
   (5) → `packages/study-reminder-shared` (14) → `packages/chat-metering` (15) → …
3. Once a workspace reaches 0, fold it into the gated `typecheck` (Step 4) and update
   the Status column above to ✅.
