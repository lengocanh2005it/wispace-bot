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
| `apps/messenger-bot` | 80 | 80 | 🔴 errors |
| `apps/discord-bot` | 28 | 28 | 🔴 errors |
| `apps/zalo-bot` | 22 | 22 | 🔴 errors |
| `packages/bot-common` | 28 | 28 | 🔴 errors |
| `packages/llm-agent` | 19 | 19 | 🔴 errors |
| `packages/chat-agent` | 19 | 19 | 🔴 errors |
| `packages/chat-metering` | 15 | 15 | 🔴 errors |
| `packages/study-reminder-shared` | 14 | 14 | 🔴 errors |
| `packages/database` | 5 | 5 | 🔴 errors |
| `packages/account-link-core` | 4 | 4 | 🔴 errors |
| `packages/cleanup-cron` | 4 | 4 | 🔴 errors |
| `packages/wispace-client` | 2 | 2 | 🔴 errors |
| `packages/reschedule-confirm` | 2 | 2 | 🔴 errors |
| `packages/contracts` | 0 | 0 | ✅ clean |
| `packages/chat-history` | 0 | 0 | ✅ clean |
| `packages/student-report` | 0 | 0 | ✅ clean |
| `packages/chat-queue-core` | 0 | 0 | ✅ clean |
| `packages/chat-pipeline` | 0 | 0 | ✅ clean |
| `packages/learner-profile` | 0 | 0 | ✅ clean |
| `packages/scheduler-core` | 0 | 0 | ✅ clean |
| `packages/bot-metrics` | 0 | 0 | ✅ clean |
| `packages/ops-health` | 0 | 0 | ✅ clean |
| `packages/webhook-inbound` | 0 | 0 | ✅ clean |
| `packages/date-utils` | 0 | 0 | ✅ clean |
| **Total** | **242** | **242** | |

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

## Known genuine defect (fix first — Step 2)

`apps/messenger-bot` — `messenger-report-delivery.service.spec.ts`:

```
error TS2820: Type '"weekly"' is not assignable to type 'NotificationCadence | undefined'.
             Did you mean '"WEEKLY"'?
```

Nine occurrences. A test asserting a cadence value that production can never emit — and
passing only because SWC strips types without resolving them. This is the first member of
the genuine-defect class to fix in Step 2.

---

## Progress log

| Date | Workspace | Errors before | Errors after | PR |
|---|---|---:|---:|---|
| 2026-09-17 | *(Step 1 complete — scripts normalized, baseline established)* | — | — | #1232 |

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
