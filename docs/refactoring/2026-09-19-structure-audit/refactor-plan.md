# Refactoring Plan — structure-codebase audit follow-through

**Source:** structure-codebase audit 2026-09-19 (this conversation) → issues #1291 (F2), #1126 comment (F1r stopgap), F3 doc rule
**Created:** 2026-09-19
**Target:** `docs/architecture-boundaries.md` claims match `scripts/check-architecture.mjs` enforcement exactly: every sibling-feature pair in all three apps is boundary-checked, root-façade import counts cannot regress upward, and the `bot-common` promotion rule is written down.

**Explicitly out of scope (maintainer decision on #1126, not this plan):**
- Option A/B for the `/core`+`/adapters` convention (migrating the ~250 root-specifier imports).
- Removing the 40 baseline cross-feature concrete edges (each removal is its own future behavior PR; the ratchet just prevents growth).

## Verification suite (recorded in manifest, run at EVERY gate)

```text
npm run architecture:test    # checker self-tests (node --test)
npm run architecture:check   # full repo boundary check
npm run format:check         # oxfmt --check apps packages
npm run lint                 # oxlint
npm run typecheck            # turbo run typecheck
npm run test                 # turbo run test (Jest)
```

`npm run build` (turbo) is run in Post-flight only — no `src/` production module changes in Chunks 1–2 (checker is `scripts/`, not shipped), Chunk 3–4 touch scripts/docs only. If a chunk is forced to touch `apps/*/src` or `packages/*/src`, add `npm run build` to that chunk's gate.

## Pre-flight Checks

- [ ] Working tree reviewed: pre-existing uncommitted files (`CONTEXT.md` modified, `docs/adr/0028-*.md` untracked, `.claude/scheduled_tasks.lock` untracked) are NOT touched or committed by this plan.
- [ ] `npm run architecture:check` passes on clean baseline (verified 2026-09-19: 736 files OK).
- [ ] Full verification suite passes before Chunk 1 starts.
- [ ] Working branch `arch/sibling-feature-boundary` created (pending user approval).
- [ ] Cross-feature edge inventory captured: `.temp/scan-cross-feature.mjs` → 58 edges (40 CONCRETE, 18 PORT), listed in `docs/refactoring/2026-09-19-structure-audit/refactor-log.md` entry 2026-09-19.

## Chunk 1: Feature registry refactor inside the checker (behavior-preserving)

**Why:** F2 prerequisite — `featureForPath`/`featureForImport` in `scripts/check-architecture.mjs` hardcode exactly two features (`MESSENGER_FEATURE_ROOT`, `STUDY_REMINDER_FEATURE_ROOT`). Generalization must land as a pure derivation mechanism first, so the enforcement flip in Chunk 2 is a one-line-visibility change, not a mixed rewrite.
**Depends on:** none
**Entry criteria:** full verification suite green; architecture:check output identical before/after this chunk.

**Steps:**
1. In `scripts/check-architecture.mjs`, add `APP_MODULE_DIRS` derived by scanning `apps/*/src/modules/*/` at startup, plus the existing app alias map (`@messenger/`, `@discord/`, `@zalo/` — already present as `APP_IMPORT`; extend to a per-app map).
2. Add `featureOfSourceFile(relativePath)` → `{app, feature} | undefined` from the `apps/<bot>/src/modules/<feature>/...` shape, and `featureOfSpecifier(relativePath, specifier)` → `{app, feature} | undefined` covering (a) alias specifiers `@<bot>/modules/<feature>/...`, (b) relative specifiers normalized against the importing file's directory.
3. Re-implement the existing `featureForPath` / `featureForImport` on top of (2) but KEEP their messenger/study-reminder-only return semantics: return a feature name only for the current two hardcoded roots, so `featureBoundaryViolation` behavior is byte-identical and existing rule names/messages do not change.
4. In `scripts/check-architecture.test.mjs`, add fixtures proving the registry DERIVES all modules of all three apps (assert on `discord-chat`, `account-link`, `zalo-oauth`, `scheduler` being recognized by the derivation function) while enforcement remains pair-scoped.
5. Run the verification suite; confirm `architecture:check` violation count unchanged (0) and behavior parity.

**Exit criteria:** all gates green; no new violations; test suite covers derivation for all 3 apps.
**Commit message:** `refactor(arch): derive the feature registry in the architecture checker (behavior-preserving)`

## Chunk 2: Enforce sibling-feature boundaries for every feature pair, all three apps (#1291)

**Why:** docs claim "Feature application/domain/infrastructure/presentation code may not cross-import concrete services or utilities" but only the messenger↔study-reminder pair fails CI today; scan found 40 unenforced concrete edges.
**Depends on:** Chunk 1
**Entry criteria:** Chunk 1 completed and verified.

**Steps:**
1. Flip `featureBoundaryViolation` to the generalized rule: any same-app cross-feature import is rejected UNLESS (a) the importing file is a composition root (`*.module.ts`), or (b) the specifier resolves into the target feature's ports — path segment `/ports/` or `/domain/repositories/` (existing Messenger port layout) or file stem ending `.port`. Remove the now-subsumed special cases `isStudyReminderPortImport` and the per-pair allowlist branches (generic rule admits the same edges).
2. Run `npm run architecture:check`; collect the expected violation set (should match the 40 CONCRETE edges from the scan; PORT edges must pass automatically — if any PORT-classified edge still fails, STOP and re-examine classifier vs rule mismatch — do not widen the rule ad hoc).
3. Add a new ratchet set `LEGACY_FEATURE_CROSS_IMPORTS` (same exact-string triplet style as `LEGACY_APPLICATION_IMPORTS`, keyed `file|specifier`): one entry per violating edge from step 2, each with a trailing comment line grouping by pair (e.g. `# scheduler -> messenger presentation wiring`). New edges not in the set fail CI.
4. Add checker test fixtures per app in `scripts/check-architecture.test.mjs`: one forbidden case (concrete cross-feature import rejected) and one allowed case (port import accepted, `*.module.ts` accepted) for a pair in messenger-bot, discord-bot, and zalo-bot; keep the existing study-reminder-pair fixtures green.
5. Update `docs/architecture-boundaries.md`: rewrite the "Messenger ↔ Study Reminder boundary (#435)" section title and text to describe the generic per-feature rule + ratchet (keep the #435 behavioral invariants paragraph — behavior claims are unchanged).
6. Run the full verification suite.

**Exit criteria:** `architecture:check` green WITH the 40-entry ratchet present; a deliberately added 41st edge fails (prove via test fixture); docs claim == machine check.
**Commit message:** `refactor(arch): enforce sibling-feature boundaries for every module of all three apps`

## Chunk 3: Root-façade per-package import-count ratchet (F1r stopgap on #1126)

**Why:** root barrel is still the primary import style (measured 2026-09-19: wispace-client 75 root vs 7 subpath, llm-agent 53 vs 20, …); the only guard against adapter leakage through root is the symbol-suffix heuristic. Ratchet stops growth without pre-empting #1126's Option A/B.
**Depends on:** none (serialized after Chunk 2 because both edit `scripts/check-architecture.mjs`)
**Entry criteria:** Chunks 1–2 verified; scan counts from step 0 below recomputed fresh at execution time (do not trust the 2026-09-19 numbers as the baseline — re-measure).

**Steps:**
1. In `scripts/check-architecture.mjs`, add `ROOT_FACADE_PACKAGES` = the 8 packages that declare `/core`+`/adapters` exports (`llm-agent`, `wispace-client`, `student-report`, `chat-metering`, `scheduler-core`, `study-reminder-shared`, `ops-health`, `account-link-core`) and a baseline object `ROOT_FACADE_IMPORT_BASELINE: Record<string, number>`.
2. In the same single pass over production TS files, count imports whose specifier is EXACTLY `@wispace/<pkg>` (bare root, no subpath); baseline = count at execution time; per package: `count > baseline` → violation "grew past baseline — import via /core or /adapters instead"; `count < baseline` → violation "shrunk — lower the baseline in check-architecture.mjs" (keeps the number honest either direction).
3. Add test fixtures in `scripts/check-architecture.test.mjs`: grow → fail; shrink-without-baseline-update → fail; exact match → pass; subpath imports never counted.
4. Add one line to `docs/architecture-boundaries.md` "Commands and CI" describing the ratchet and linking #1126.
5. Run the full verification suite.

**Exit criteria:** baseline recorded from a fresh measurement; both drift directions fail CI; `npm run architecture:test` green.
**Commit message:** `refactor(arch): ratchet root-facade imports per package pending #1126`

## Chunk 4: bot-common promotion rule (F3, docs-only)

**Why:** `bot-common` is the only "common"-named package; it currently earns its name, but without a written promotion bar the next file has no gate.
**Depends on:** none
**Entry criteria:** none.

**Steps:**
1. In `.claude/rules/clean-architecture.md`, add under the shared-package guidance: new `bot-common` content requires ≥2 real consuming apps; single-consumer code stays inside its app. Reference the audit rationale (#1126 comment 2026-09-19).
2. `npm run format:check` (docs markdown not oxfmt-covered → run full lint/format anyway to be safe).

**Exit criteria:** rule text present; format/lint green.
**Commit message:** `docs(architecture): record bot-common promotion rule`

## Post-flight Checks

- [ ] Full verification suite + `npm run build` pass
- [ ] No TODO/FIXME markers left from this refactor
- [ ] Audit findings resolved within scope: F2 closed (#1291 acceptance list), F1r landed as the stopgap (#1126 remains open for the A/B decision), F3 closed
- [ ] `LEGACY_FEATURE_CROSS_IMPORTS` entry count == number of concrete edges recorded in the log at Chunk 2 step 2
- [ ] Manifest `status → completed`, final log entry written
