# Stale issue audit

Audited by direct inspection (main, `7791f2c2`). Each verdict was checked against
the working tree, not trusted from the issue text.

## Summary

All 250 open issues were covered: 234 claim-by-claim against the working tree in
six subagent slices, each STALE and ALREADY-DONE verdict then re-checked by the
parent pass — which overturned five of them, twice finding that a single verified
number had been generalised to the whole issue. The last 16 were audited in a
seventh pass (two subagents plus direct verification).

| Verdict | Count |
| --- | --- |
| STALE (a falsifiable claim is contradicted) | **31** |
| ALREADY-DONE (the work shipped) | **8** |
| SOUND (every checkable claim held) | 195 |
| UNVERIFIABLE (no repo-checkable claim) | 16 |

**Do not close any of the 31 STALE issues.** Every one has stale citations or
drifted numbers sitting on top of work that is still genuinely open — or, for the
eight marked ▲, a premise that the reorganization already resolved. The 8
ALREADY-DONE issues are the ones that can be closed.

### The three things worth acting on

1. **19 issues cite moved paths**, all from one reorganization. The full
   old → new mapping is in the table below; a single batch pass clears it.
2. **8 issues can be closed** — listed under "Already done" below.
3. **#1136 is the one to distrust**: its headline "43% dead exports" is still
   roughly right (42.8%) while both absolute numbers are ~33% low, so it reads as
   accurate at a skim. That is the worst failure mode in this audit.

### Five verdicts overturned during review

| Issue | First verdict | Correction |
| --- | --- | --- |
| #1355 | ALREADY-DONE (subagent) | Not done — the subagent counted `chat-pipeline` specs, but the issue is about `chat-queue-core` |
| #1219 | SOUND (parent) | STALE — I verified 1 of the 4 tools the issue names |
| #1227 | SOUND (parent) | STALE — the 93-timestamptz number is exact, but the ADR path and a decorator count are wrong |
| #1300 | SOUND (parent) | STALE — the missing `Idempotency-Key` header is real, but `send-study-reminders` is Messenger-only, so the AC is unsatisfiable |
| #1353 | STALE (self) | Partially wrong — the orphan is real, but one of the six was since referenced |

The recurring error is mine, not the subagents': **matching one number inside a
claim is not verifying the claim.** An issue is a bundle of claims that rot
independently, and three of the five corrections were cases where I verified one
true number and generalised it to the whole issue. The lesson generalises past
this audit — it is the same failure #722 made when it asserted "53 fixtures".

## The dominant root cause

`packages/database/src/services/*.ts` was reorganized into bounded-context
subfolders (`cross-cutting/`, `metering-and-operations/`, `account-linking/`,
`platform-interaction/`), report-claim/send-job repositories moved to
`packages/scheduler-core/src/adapters/`, cleanup-cron and webhook-inbound services
moved to `src/adapters/`, and `mask-external-id.ts` moved to
`packages/bot-common/src/masking/`.

**19 open issues still cite the old `packages/database/src/services/` paths**:
1425, 1412, 1411, 1360, 1359, 1358, 1343, 1341, 1338, 1227, 1226, 1225, 1223,
1175, 1173, 1168, 1138, 1137, 1135.

Verified mechanically: 9 distinct `database/src/services/*.ts` paths are cited
across those issues, and **all 9 are gone — 0 still present at the old path.**

Old path → new path:

| Old | New |
| --- | --- |
| `services/web-activity.service.ts` | `services/cross-cutting/web-activity.service.ts` |
| `services/canonical-platform.service.ts` | `services/cross-cutting/canonical-platform.service.ts` |
| `services/learner-usage-query.ts` | `services/cross-cutting/learner-usage-query.ts` |
| `services/cron-leader-lease.service.ts` | `services/cross-cutting/cron-leader-lease.service.ts` |
| `services/privacy-data.service.ts` | `services/metering-and-operations/privacy-data.service.ts` |
| `services/notification-preference.service.ts` | `services/metering-and-operations/notification-preference.service.ts` |
| `services/privacy-cleanup-reconciler.service.ts` | `services/metering-and-operations/privacy-cleanup-reconciler.service.ts` |
| `services/platform-link-state.service.ts` | `services/account-linking/platform-link-state.service.ts` |
| `services/platform-report-claim.repository.ts` | `packages/scheduler-core/src/adapters/platform-report-claim.repository.ts` (left the package) |

Five further moved paths, outside that directory:

| Old | New | Issues citing it |
| --- | --- | --- |
| `packages/webhook-inbound/src/services/platform-webhook-inbound-event.service.ts` | `packages/webhook-inbound/src/adapters/platform-webhook-inbound-event.service.ts` | 1414, 1345 |
| `packages/llm-agent/src/utils/llm-grounding.utils.ts` | `packages/llm-agent/src/grounding/llm-grounding.utils.ts` | 1297, 1192 |
| `packages/bot-common/src/mask-external-id.ts` | `packages/bot-common/src/masking/mask-external-id.ts` | 1359 |
| `packages/cleanup-cron/src/platform-cleanup-cron.service.ts` | `packages/cleanup-cron/src/adapters/platform-cleanup-cron.service.ts` | 1338 |
| `packages/llm-agent/src/utils/secret-redaction.utils.ts` | `packages/llm-agent/src/safety/secret-redaction.utils.ts` | 1168 |

In most of these the *finding* still holds and only the citation is stale. In
several — #1225, #1224, #1226, #1223 — the move actually resolved the reported
problem, so the issue is no longer describing reality at all.

A mechanical sweep over all 250 issue bodies (581 concrete path references)
confirms this pattern and surfaced no other systemic drift.

## Actions taken (2026-09-27)

Applied against `lengocanh2005it/wispace-bot`:

- **6 issues closed**, each with an evidence comment posted first: #1329, #1331,
  #1245, #1281, #1133, #1267.
- **2 issues deliberately left open** despite being partly shipped, because real work
  remains: #1138 (`partial`/`locked`/`isEnabled()===false` never exercised) and
  #1320 (five `.env` variants still unignored — verified with `git check-ignore`).
  Each got a comment recording what landed and what did not.
- **22 issue bodies repointed** to post-reorganisation paths, 34 replacements, now
  idempotent (a re-run reports 0 changes). #1286 also had its line counts corrected
  (401/298/272) and env inventory (26/37/27).
- **9 issues annotated** with the specific claim that no longer holds: the 8 marked ▲
  plus #1136, which carries a dedicated warning because its title reads as accurate
  while both absolute numbers are ~33% low.

**Methodology note.** PowerShell's `Get-Content | Measure-Object -Line` **undercounts**
relative to a plain line split — it reported 378/286/260 for the three link-reconcile
crons that are actually 401/298/272. It also reported `eval-harness.ts` as 1,253 lines
when it was 1,307. Every count that ended up in a GitHub comment was re-measured with a
line split before writing. This is very likely the source of the original "1,253 lines"
figure in #722.



Re-verified by the parent pass before this list was written.

| Issue | Evidence the work shipped |
| --- | --- |
| **#1329** | All 9 data-pipeline alerts present in **both** `docs/monitoring-alerts.md` and `deploy/monitoring/alert.rules.yml` |
| **#1331** | All 10 LLM alerts present in both files |
| **#1245** | `docs/adr/0025-database-portability-boundary.md` Accepted (143 lines); `CONTEXT.md:1182` defines the term; `.claude/rules/clean-architecture.md:131` links it |
| **#1281** | Gateway is on `clientReady` (`discord-chat.gateway.ts:106-107`, `discord-platform-connectivity.service.ts:36`); grep for `ready` handlers in `apps/` returns **no matches** |
| **#1133** | grep for `compaction|CompactionCache|summaryCache` returns **zero code matches**; ADR-0017:16 records the removal as a deliberate decision |
| **#1267** | `docs/monitoring-alerts.md` exists (356 lines); **35 of 41** alerts named — only the 6 `SloBurn*` missing |
| **#1138** | the `drift` outcome case is now asserted (`redis-burst-reconciler.spec.ts:95-101`); `partial`, `locked`, disabled still open |
| **#1320** | the `.env.shared` half: untracked in `4779cd2e`, `git ls-files` has no entry — that AC is met. The rest of the issue stands (`.env.local`, `.env.production`, `.env.staging`, `.env.dev`, `.env.shared.local` are all still unignored) |

## Stale — 28 issues, with the specific claim that broke

Most are a drifted number or a moved path sitting on top of still-valid work.
The ones where the **premise itself no longer holds** are marked ▲.

| Issue | The claim that broke |
| --- | --- |
| ▲ #1225 | Both named raw-SQL violations moved out of `application/`; a `.query(` scan of all 15 `application/` dirs returns **0** files |
| ▲ #1251 | "no message-splitting utility anywhere" is false — `splitMessengerBubbles` and Discord's `splitMessage` both exist (no *shared* one) |
| ▲ #1224 | The Zalo copy moved to `infrastructure/persistence/`; the layering complaint is already fixed. "157 vs 165 lines" is now 297 vs 346 |
| ▲ #1132 | `compactionOutcomeInc` and the whole compaction feature were deleted |
| ▲ #1428 | `LEGACY_APPLICATION_IMPORTS` no longer exists — and a ratchet test **forbids** recreating it, so the AC is unsatisfiable |
| ▲ #1425 | The Discord re-engagement service has **no** `WebActivityService` import; its comment says the opposite |
| ▲ #1137 | Cited lines 705/777 are past the EOF of a 676-line file; the "four copies" duplication is now one |
| #1226 | `cron-leader-lease` moved to `cross-cutting/`; report-claim left the package for `scheduler-core/src/adapters/` |
| #1223 | `hashtextextended` is at `:166,173`, not `:150/:157`; the issue also self-contradicts on four vs five call sites |
| #1219 | 50 entries, not 56 — `platform-express` is in 8 packages, not 14 |
| #1227 | Cites a non-existent ADR path (0020 vs the real 0025); 36 decorators, not 72 |
| #1233 | Text moved `AGENTS.md:129` → `:144`; `verify` has since gained two steps |
| #1230 | The shared script grew 1187 → **1495** lines, moving every citation |
| #1228 | Same file grew to 1495; names 8 of 9 suites; all three line citations moved |
| #1127 | Modules grew to 924/763/695 lines and 36/28/42 providers (~26% above claim) |
| #1136 | 922 exports / 395 dead, not 686/297. 10 of 21 packages have no `src/index.ts` at all, so the method is obsolete |
| #1168 | Registry moved to `bot-common/src/masking/runtime-secrets.ts`; the `VERIFY_INTENT_TABLES` allowlist guard it cites no longer exists |
| #1178 | `CONCURRENCY_LIMIT = 3` replaced by a configurable `options.concurrencyLimit` |
| #1423 | 79 metric families, not 69 |
| #1400 | Four `new CircuitBreaker(` sites, not three — `with-retry.ts:114` is missing from the list |
| #1338 | The `identifier()` escaper is not the only copy; `migration-data-source.ts:51-53` has a byte-identical one |
| #1385 | Messenger's `discardRecord` **is** generation-fenced; the gap is 2 platforms, not 3 |
| #1416 | The `eval-` filename rule misreads the guard — it constrains the fixture's `externalUserId` **field** |
| #1353 | 12 test files, not 11; `vps-hardening-check.sh` is now referenced by a workflow |
| #1185 | 30 `*_ENABLED` flags, not 29 |
| #1327 | `getOrFetch` appears 4× on Messenger, not 0 — the "only through a facade" claim is false |
| #1306 | 106 wildcard deps, not 103 |
| ▲ #1293 | Two of six links falsified: `CLASSIFIER_LABELS` already includes `ABUSE` and `CRISIS`, and `contentClassifier` is wired on all three bots — the "silent no-op" failure mode is gone |
| #1300 | `send-study-reminders` exists on **Messenger only** (one occurrence repo-wide), so the AC "on all 3 bots" is unsatisfiable |
| #1286 | Beyond the moved path: link-reconcile crons are now 401/298/272 lines (claimed 373/283/257); env-key inventory is 26/37/27 (claimed 26/31/21) |
| #1320 | (listed above under already-done for the `.env.shared` half) |

## Final pass — the last 16 issues

Parent-verified, final pass (these 16 completed the sweep):

- **#1298 — SOUND, and AC1 is already met.** Verified: `INTERNAL_API_KEY` is the only ops
  credential (`internal-api-key.guard.ts:40`), and the identical
  `@UseGuards(InternalApiKeyGuard, ThrottlerGuard)` is at `scheduler.controller.ts:80`,
  `discord-ops.controller.ts:25`, `zalo-ops.controller.ts:46`. No read/write split exists.
  AC1 ("recorded as full-admin in docs") is satisfied by the threat models:
  `docs/threat-model-wispace-data-and-outbound.md:160` ("one static `INTERNAL_API_KEY`") and
  `:32` ("can trigger sends"), plus `threat-model-host-and-deployment.md:105` ("Sole gate on
  ops routes incl. privacy purge and report send"). Its mitigation column at `:166` already
  records the un-split decision. So the issue is narrower than it reads: only AC2/AC3 (a
  recorded keep-single-key decision, and the split itself) remain.

- **#1300 — STALE, corrected from my own SOUND verdict.** I verified the headline (no
  `Idempotency-Key` header exists anywhere — `apps/**/*.controller.ts` has zero `@Headers`
  matches) and generalised to the whole issue. The AC claim "**on all 3 bots**" is false:
  `send-study-reminders` occurs **exactly once in the entire repo**, at
  `apps/messenger-bot/src/modules/scheduler/presentation/controllers/scheduler.controller.ts:155`.
  The shared `PlatformOpsController` exposes only `send-reports` and `sync-study-reminders`.
  So the trigger set is 2 shared + 1 Messenger-only, and the AC cannot be met as written.

- **#1293 — STALE; two of its six sequencing links are falsified in-repo.** Re-verified:
  `CLASSIFIER_LABELS` is `['SAFE','INJECTION','DISCLOSURE_PROBE','ABUSE','CRISIS']`
  (`content-classifier.port.ts:15-21`), so the "no CRISIS label / no ABUSE label" premise is
  false; and `contentClassifier` is constructed and injected on **all three** bots
  (`discord-chat.module.ts:314,394`; `zalo-chat.module.ts:456,535`;
  `chat-pipeline.module.ts:374,484`), so the "silent no-op on Discord/Zalo" failure mode is
  gone. Five of its referenced issues are already CLOSED.

- **#1286 — STALE beyond the known path drift.** In addition to `deploy/vps-deploy.sh` → 
  `.github/scripts/vps-deploy.sh`, the link-reconcile crons it counts as 373/283/257 lines
  are now 401/298/272, and its env-key inventory (26/31/21) is now 26/37/27.

- **#1301 — STALE (one number).** `PlatformOpsController`
  (`packages/bot-common/src/health/platform-ops.controller.ts:61-107`) has exactly **6**
  routes, as claimed. But Messenger's `SchedulerController` has **11**, not 10:
  `send-reports`, `send-reports/retry-dispatch`, `mapping/relink`, `study-calendar/sync`,
  `sync-study-reminders`, `send-study-reminders`, `study-reminder/evening-rollover`,
  `ops/clarification/clear`, `privacy/unlink`, `privacy/delete`, `privacy/export`
  (lines 100-217). The drift itself is the issue's point and still stands.

- **#1316 — SOUND.** `docs/privacy-erasure-verification.md` exists, but a search of it for
  `backup|restore|14-day|retention|rotation` returns only three incidental hits (a Redis
  restore drill at :58, a retention heading at :72, and a seven-day job-retention query at
  :82). It never states that erased data persists in the nightly dump and offsite bucket
  until rotation. A repo-wide search for `re-erasure|re_erasure` in `docs/` returns **no
  matches**, so the runbook step the issue asks for is also absent. Both ACs are genuinely
  open.

- **#1299 — SOUND.** `apps/discord-bot/src/main.ts:9-11` and
  `apps/zalo-bot/src/main.ts:11-13` both read `CORS_ORIGIN`, split it on commas, and pass
  the array straight to `app.enableCors({ origin })` with no allowlist validation — so
  `CORS_ORIGIN=*` yields a wildcard, exactly as claimed. Messenger has no `enableCors`
  anywhere, which matches the issue naming only the Discord/Zalo bots.

- **#1311** — UNVERIFIABLE. The body is a plan with no checkable code claim (who is told,
  in what words, at what threshold). Nothing to contradict.

- **#1295 — SOUND.** The counter exists and is platform-aware
  (`bot-metrics.service.ts:275`, `incLlmInjectionBlocked(source, platform)` at `:925`),
  but a repo-wide search for `incLlmInjectionBlocked` returns exactly **two** hits: the
  definition, and one call site — `apps/messenger-bot/src/modules/messenger/chat-pipeline.module.ts:431`
  with the literal `'messenger'`. Discord and Zalo never increment it, so their
  injection-blocked metrics really are noop.

- **#1287 — SOUND.** All ten named kill switches still exist in non-spec code:
  `CHAT_IDEMPOTENCY_CLEANUP_ENABLED`, `CHAT_QUOTA_EVENTS_CLEANUP_ENABLED`,
  `DEAD_LETTER_CLEANUP_ENABLED`, `MESSAGE_LOG_CLEANUP_ENABLED`,
  `OAUTH_STATE_CLEANUP_ENABLED`, `PLATFORM_LINK_AUDIT_CLEANUP_ENABLED`,
  `REPORT_CLAIMS_CLEANUP_ENABLED`, `WEBHOOK_INBOUND_CLEANUP_ENABLED` and
  `LLM_USAGE_CLEANUP_ENABLED` each appear in exactly one non-spec file, and
  `DATA_QUALITY_CRON_ENABLED` in two. None has been collapsed into a family switch, so the
  in-slice decision is still entirely open.

#1286, #1293, #1295, #1298, #1299, #1300, #1301, #1308, #1309, #1310, #1311,
#1316, #1318, #1324, #1326.

Final pass outcomes for the 16 listed above: **3 STALE** (#1286, #1293, #1300),
**1 more corrected to STALE** (#1301, eleven routes not ten), **9 SOUND**
(#1295, #1298, #1299, #1308, #1309, #1310, #1311, #1316, #1318), **1 UNVERIFIABLE**
(#1326). #1324 is UNVERIFIABLE too: every falsifiable datum in it is
production-instance state (`pg_settings`, `data_checksums`, disk usage, dump
dates) that this repo does not contain, consistent with #527 recording production
Postgres as an unmanaged co-tenant.

A useful pattern: the nine SOUND resilience/privacy/dependency issues cite paths
that survived the reorganization intact (`packages/bot-common/src/secrets/vault-secrets.ts`,
`docs/data-catalog.md`, `deploy/postgres-*.sh`). The two that rotted, #1300 and
#1301, rotted through *route-surface drift* instead — endpoints were added or are
Messenger-only — which is a different root cause from the reorg and will keep
happening as the ops API grows.

## Self-verified slice — verdicts CORRECTED during review

### #1219 — SOUND, corrected to STALE
My first pass checked only `@nestjs/cli` (present in all 14 packages' `dependencies`)
and matched the issue's "14 packages", concluding SOUND. That was wrong: the issue
claims **four** tools across 14 packages = 56 entries. Re-measured per package:

| dependency | packages | of 14 |
| --- | --- | --- |
| `@nestjs/cli` | 14 | 14 |
| `@nestjs/schematics` | 14 | 14 |
| `@nestjs/testing` | 14 | 14 |
| `@nestjs/platform-express` | 8 | **8** — absent (not even devDeps) from chat-agent, ops-health, reschedule-confirm, student-report, wispace-client, bot-metrics |

True total is **50 (14×3 + 8)**, not 56, and "dead weight in the other thirteen"
should be "the other seven". Lesson: matching one number inside a claim is not the
same as verifying the claim.

## Chunk 3 (issues 1227–1284) — subagent report, key claims re-verified

Counts: STALE 5 | ALREADY-DONE 3 | SOUND 30 | UNVERIFIABLE 4

- **#1227** — STALE; see the corrected entry in the self-verified section.
- **#1233** — citation only; the four-way `verify` drift is still real, do not close.
  The text moved from `AGENTS.md:129` to `:144` and is still missing
  `architecture:check`/`knip:deps`. Since filing, `verify` and `verify:affected` now differ
  only by `--affected`, and both gained `workspace-deps:check` + `file-size:check`.
- **#1230** / **#1228** — the shared script grew from 1187 to **1495 lines**, moving every
  line citation in both issues. #1228 also names eight of the nine suites (the ninth is
  `chatQueueSuite`).
- **#1251** — the premise "no message-splitting utility anywhere in the repo" is **false**:
  `splitMessengerBubbles` exists (`messenger-text.utils.ts:8`) and Discord has its own
  `splitMessage` (`discord-report-delivery.service.ts:132-156`, with
  `DISCORD_MAX_MESSAGE_LENGTH = 2000`). The issue's real point survives — there is no
  *shared* helper, so the two are per-app copies.
- **#1281** — ALREADY-DONE: the gateway is on `clientReady`
  (`discord-chat.gateway.ts:106-107`, `discord-platform-connectivity.service.ts:36`); a
  repo-wide grep for `ready` handlers in `apps/` returns no matches. The necord pin is #1280.
- **#1267** — ALREADY-DONE largely: `docs/monitoring-alerts.md` exists (356 lines);
  **35 of 41** alerts are named, only the 6 `SloBurn*` are missing.
- **#1245** — ALREADY-DONE: ADR-0025 is Accepted, `CONTEXT.md:1182` defines the term, and
  `.claude/rules/clean-architecture.md:127` links it.

## Chunk 5 (issues 1124–1178) — subagent report, key claims re-verified

Counts: STALE 6 | ALREADY-DONE 2 | SOUND 26 | UNVERIFIABLE 6

- **#1133** — ALREADY-DONE. Re-verified: grep for `compaction|CompactionCache|summaryCache`
  over the whole repo returns **zero code matches**. The only two hits are in
  `docs/adr/0017-llm-agent-context-budget-and-pipeline.md:10,16`, and line 16 records the
  removal as a deliberate decision ("Remove the unused streaming adapter and agent APIs,
  semantic compaction, …"). The issue's own "if removed" branch is the one that was taken.
- **#1132** — STALE for the same reason: `compactionOutcomeInc` and the whole compaction
  feature are gone. The residual valid half still holds —
  `packages/llm-agent/src/agent.service.ts:210-212` still only logs
  `History truncated ${droppedTokens} tokens` with no counter.
- **#1136** — the largest number in the audit, and it is wrong. Re-measured: **922** exports
  and **395** dead, not 686/297. The 43% headline survives by accident (42.8%) because
  exports and dead exports grew in proportion — a skimming reader would call it accurate.
  The stated method is obsolete: re-verified that **11 of 21** packages have a
  `src/index.ts` and **10 do not** (llm-agent, database-adjacent ones, chat-metering,
  ops-health, scheduler-core, wispace-client, …), because those publish `/core` + `/adapters`
  per ADR-0041. `MemoryCompactionCacheConfig` and `RedisCompactionCacheConfig` do not exist,
  and `AGENT_TOOL_NAMES` now has production consumers, not only specs.
- **#1137** — cited lines 705/777 are past the EOF of a 676-line file. The claim-CAS
  duplication is now **one** implementation, not four. All three reader names were renamed
  (`hasSentScheduledReportToday` → `hasSentScheduledReportOn`, etc.).
- **#1127** — modules grew: 924/763/695 lines (not 722/670/547) and 36/28/42 providers
  (not 22/18/…), ~2382 lines total. The substance (three hand-assembled composition roots,
  no shared factory) holds.
- **#1168** — registry moved to `packages/bot-common/src/masking/runtime-secrets.ts:16`.
  The secret-name drift it reports is real. The folded-in `deleteVerifyIntent` item is
  stale: the `VERIFY_INTENT_TABLES` allowlist guard no longer exists in code.
- **#1178** — `CONCURRENCY_LIMIT = 3` no longer exists; the limit is now the configurable
  `options.concurrencyLimit`. The fairness gap it argues is unaffected.
- **#1175** — SOUND, and a useful contrast: it says "four `new CircuitBreaker(...)` sites",
  which matches HEAD exactly (measured independently: `llm-execution.service.ts:89`,
  `messenger-outbound.service.ts:122`, `db-circuit-breaker.ts:104`, `with-retry.ts:114`).
  Two issues filed the same week counted the same construct — #1175 says four and is right,
  #1400 says three and is stale.

## Chunk 2 (issues 1286–1330) — subagent interim, key claims re-verified

Counts so far: STALE 3 | ALREADY-DONE (partial) 1 | SOUND ~26 | 16 still in progress

- **#1320** — mixed. The claim "`.env.shared` is still tracked at HEAD, and its removal is
  only staged, not committed" is **false**. Re-verified: `git rev-parse HEAD:.env.shared`
  → *does not exist*; `git ls-files` has no entry; commit `4779cd2e "chore: untrack
  .env.shared"` removed it. That AC is **already satisfied**. The rest of the issue
  holds: `.gitignore` covers only `.env`/`.env.shared`, so `.env.local`, `.env.production`,
  `.env.staging`, `.env.dev` and `.env.shared.local` are all unignored.
- **#1327** — headline evidence contradicted: `getOrFetch` appears **4 times** under
  `apps/messenger-bot/src` (`agent-tool-edges.adapter.ts:20`, `scheduler.module.ts:113`,
  `task-score-average-api.service.ts:47`, `study-reminder.module.ts:213`), calling
  `cache.getOrFetch('goals', …)` directly rather than through a facade. The underlying gap
  is real: `invalidateUser` has 0 hits on Messenger, and `WispaceCalendarService` has no cache.
- **#1306** — protocol claims true (0 `workspace:`, one `^0.0.1`), but the wildcard count is
  now **106**, not 103, across the 24 workspace manifests.

## Chunk 4 (issues 1180–1226) — subagent report, key claims re-verified

Counts: STALE 5 | ALREADY-DONE 0 | SOUND 29 | UNVERIFIABLE 6

- **#1226** — `cron-leader-lease.service.ts` moved into
  `packages/database/src/services/cross-cutting/`; `platform-report-claim.repository.ts`
  left `packages/database` entirely for `packages/scheduler-core/src/adapters/`.
  The other four cited sites verify exactly.
- **#1225** — **premise resolved**: both named SQL violations moved out of
  `application/`, and a repo-wide `.query(` scan of any `application/` path returns
  zero files. The check would now pass with no exceptions. Also "ten existing
  scripts" is now 11 `check-*.sh`.

  Independently re-verified: 15 `application/` directories exist and **0** files in
  them contain `.query(`. Both named files now sit on the infrastructure side
  (`apps/zalo-bot/.../zalo-oauth/infrastructure/persistence/zalo-account-link.service.ts`,
  330 lines; `apps/messenger-bot/.../chat-rate-limit/infrastructure/cron/chat-idempotency-cleanup-cron.service.ts`,
  82 lines). `scripts/check-raw-sql-location.sh` still does not exist, so the
  guard the issue proposes is genuinely still unbuilt — but the violations it
  exists to catch are gone.
- **#1224** — Zalo copy relocated to
  `apps/zalo-bot/src/modules/zalo-oauth/infrastructure/persistence/`, so the layering
  complaint is already fixed. The duplication it was tracking is still unfixed, but
  "157 vs 165 lines" is now 297 vs 346.
- **#1223** — `hashtextextended` sits at `chat-rate-limit.repository.ts:166,173`, not
  `:150/:157`. The issue also contradicts itself: body says "Four call sites" then
  lists five, and its own AC says five.
- **#1219** — see correction above.

**Root cause shared by these five:** one reorganization (scheduler-core extraction +
`cross-cutting/` split) moved files without updating the issues that cite them by path.

## Chunk 0 (issues 1389–1432) — subagent report, key claims re-verified

Counts: STALE 5 | ALREADY-DONE 0 | SOUND 37

- **#1428** — the `LEGACY_APPLICATION_IMPORTS` allowlist the issue says to empty **no longer
  exists**. It survives at exactly one place, `scripts/check-architecture.test.mjs:255`,
  inside a ratchet test asserting it stays gone
  (`assert.equal(source.includes('LEGACY_APPLICATION_IMPORTS'), false)`).
  Re-verified: grep across `scripts/` returns 1 hit, that assertion. The AC is
  unsatisfiable as written. The underlying detection gap is still real.
- **#1423** — "69 metric families" → **79**. Re-verified: 79 `new (Counter|Gauge|Histogram)(`
  in `packages/bot-metrics/src/bot-metrics.service.ts`, 0 in the package's other files.
  Finding intact: no throttler metric exists anywhere.
- **#1400** — "three `new CircuitBreaker(` sites" → **four**. Re-verified: 4 non-spec sites
  (`llm-execution.service.ts:89`, `messenger-outbound.service.ts:122`,
  `packages/database/src/db-circuit-breaker.ts:104`, and
  `packages/wispace-client/src/utils/with-retry.ts:114`, which the issue omits).
- **#1425** — the Discord re-engagement consumer claim is contradicted: that service has no
  `WebActivityService` import, and its comment says the opposite (per #595). The cited file
  also moved to `packages/database/src/services/cross-cutting/` and is 127 lines, not 120.
- **#1416** — the `eval-` filename prefix misreads the privacy guard.
  `privacy-guard.spec.ts:25` constrains the fixture's `externalUserId` **field**, not the
  filename; `fixtures/eval-*.json` is 0 files.

**Cross-cutting citation drift (findings intact, paths moved):**
`packages/database/src/services/*` was re-split into `cross-cutting/`,
`metering-and-operations/`, `account-linking/`, `platform-interaction/`. Report-claim and
send-job repositories moved to `packages/scheduler-core/src/adapters/`. `mask-external-id.ts`
moved to `packages/bot-common/src/masking/`. Affects the cited paths of roughly 10 issues.

## Chunk 1 (issues 1328–1388) — subagent report, re-verified

Counts: STALE 3 | ALREADY-DONE 2 (after correction, see below) | SOUND 37

### STALE
- **#1338** — claims the ops-health `identifier()` escaper is the *only* copy in the tree.
  `packages/database/src/migration-data-source.ts:51-53` has a byte-identical
  `quoteIdentifier`, predating the issue. The AC (unify into one escaper) is still
  unmet; the target is 2 local copies, not 1.
- **#1385** — claims `discardRecord` has no generation fence "on all three platforms".
  The Messenger twin is fenced
  (`typeorm-messenger-link-verify-record.repository.ts:258-263`,
  `discardRecord(psid, intentGeneration?)`). Only Discord `:78-80` and Zalo `:69-71`
  are unfenced. Scope is 2 platforms, not 3.
- **#1353** — 11 test files → now 12; 10 invoked → now 11. `vps-hardening-check.sh` is
  now referenced at `deploy-bot-reusable.yml:376`, so one of the six orphans resolved.

### ALREADY-DONE (independently re-verified)
- **#1329** — all 9 data-pipeline alerts present in BOTH `docs/monitoring-alerts.md`
  and `deploy/monitoring/alert.rules.yml`. AC satisfied.
- **#1331** — all 10 LLM alerts present in both files. AC satisfied.

### Correction to the subagent's report
The subagent reported **#1355 as ALREADY-DONE**, citing "870 lines of specs". That
counted `packages/chat-pipeline`, but #1355 is about **`chat-queue-core`**. The real
package has 2 specs (453 + 305 lines) and neither asserts `CHAT_MAX_PENDING_MESSAGES`
(0 occurrences) or rehydration (0 occurrences). **#1355 is NOT done** — two explicit
acceptance items are unimplemented. Verdict: SOUND, still open.

## STALE (partial — the core claim still holds, a number drifted)

### #1353 — STALE (one number)
- Claim: "`.github/scripts/tests/` contains 11 `*.test.sh` files"
- Reality: **12**. `backup-monitor.test.sh` was added by #1325, after the issue was written.
- Still correct: `check-database-type-imports.test.sh` remains the only test no workflow invokes
  (11 of 12 invoked). `scripts/detect-index-drift.sh:4` still self-declares `# CI check:`
  while grep across `.github/workflows/` returns zero hits.
- Fix: change 11 → 12.

### #1185 — STALE (one number)
- Claim: "29 `*_ENABLED` flags exist"
- Reality: **30** real flags (31 distinct minus `FOO_RUNTIME_SYNC_ENABLED`, a test fixture).
  `DOPPLER_RUNTIME_SYNC_ENABLED` is a close variant of `DOPPLER_*`; excluded.
- Fix: change 29 → 30, or reword to "roughly thirty" so it does not rot again.

## SOUND (spot-verified)

- **#1373** — pin set is exactly 3 files (enumerated all 124 fixtures:
  `apps/{discord,messenger,zalo}-bot/src/shared/prompts/*-chat.system.txt`).
  `packages/llm-agent/src/load-system-prompt.ts:18` reads `.trim()` then caches with no
  empty check — matches "both prompt loaders happily cache an empty read" exactly.
- **#1241** — no `stratum`/`difficulty` anywhere in `guardrail-battery.ts`;
  **0 of 124** fixtures carry a `difficulty` field; no production-turn sampler exists.
- **#1227** — STALE, corrected from my own SOUND verdict below. The issue points at
  `docs/adr/0020-database-portability-boundary.md`, which **does not exist** — the real
  0020 is `0020-locked-evaluator-rehash-boundary.md`, and the portability ADR is
  `0025-database-portability-boundary.md`. Decorator count is **36**
  (20 `@CreateDateColumn` + 16 `@UpdateDateColumn`), not the claimed 72.
  *(My original note: "93 timestamptz" verified — 49 in migrations + **93 in entity files**
  — and that number is exact. The error was generalising one verified number to the whole
  issue, the same mistake as #1219. First pass also measured migrations only and wrongly
  looked like a mismatch.)*
- **#1209** — "8 tools" verified, and pinned by a test at
  `packages/llm-agent/src/agent.tools.policy.spec.ts:11` (`toHaveLength(8)`).
- **#1354** — `AGENTS.md:382` points at
  `apps/messenger-bot/src/infrastructure/database/migrations/`, which does not exist
  (only `entities/` is there). Real migrations live in `packages/database/src/migrations/`.
- **#1219** — SUPERSEDED: my first verdict here was wrong. See the correction at the
  top of this file.

## Note on method

Two of the eight checks first produced a false STALE verdict because the measurement
scope was wrong, not the issue. Numeric claims in these issues are scoped precisely
("in entities", "in fixtures"); a repo-wide grep is not the same measurement.
