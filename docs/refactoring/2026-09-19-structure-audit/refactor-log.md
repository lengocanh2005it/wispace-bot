# Refactor Log — structure-codebase audit follow-through

## 2026-09-19 — Session 1

- Audit produced three findings (F1 root façade / subpath convention → issue #1126 already open, updated with fresh measurements; F2 sibling-feature rule covers one pair → new issue #1291 created, milestone 9, sub-issue of #432; F3 bot-common promotion rule → doc line, Chunk 4).
- Measured `npm run architecture:check` green on 736 files (pre-flight baseline).
- Cross-feature edge inventory via `.temp/scan-cross-feature.mjs` (TypeScript parser, production .ts only, excludes `.spec.ts`/`.d.ts`/`*.module.ts`): **58 edges — 40 CONCRETE (to be ratcheted), 18 PORT (stay allowed)**.
  - messenger-bot CONCRETE pairs: messenger→chat-rate-limit(6), messenger→display-name(1), messenger→student-report(3), scheduler→chat-rate-limit(2), scheduler→messenger(6), scheduler→study-reminder(3), student-report→llm-execution(1), student-report→llm-usage(1), study-reminder→student-report(1), display-name/llm-usage→messenger are PORT not CONCRETE.
  - discord-bot CONCRETE pairs: account-link→discord-chat(3), discord-chat→account-link(4), discord-ops→discord-chat(1), discord-reengagement→account-link(1), discord-reengagement→discord-chat(1).
  - zalo-bot CONCRETE pairs: zalo-chat→zalo-oauth(3), zalo-ops→zalo-chat(1), zalo-webhook→zalo-chat(1).
  - Exact file|specifier triplets are regenerated at Chunk 2 step 2 (counts here are the size expectation; the scan output in this session's record is the source).
- Plan written: `docs/refactoring/2026-09-19-structure-audit/refactor-plan.md` (4 chunks), manifest initialized. Status: **awaiting user sign-off** — no code changed yet.
- State files relocated from repo root into `docs/refactoring/2026-09-19-structure-audit/` at user request (matches the repo "no markdown outside docs/" boundary).
- Pre-existing uncommitted files NOT owned by this refactor (leave alone): `CONTEXT.md` (modified), `docs/adr/0028-per-learner-llm-admission-cap.md` (untracked), `.claude/scheduled_tasks.lock` (untracked).

## 2026-09-19 — Session 1 (later)

- Tracker mapping agreed with user: Chunks 1+2 execute under **#1291**; Chunks 3+4 merged into new **#1292** (root-facade ratchet + bot-common promotion rule, milestone 9, sub-issue of #432).
- User directive: **create issues only, no code yet** — plan status stays `awaiting-signoff`; implementation kickoff still requires the 3 pre-flight confirmations (branch + commit authorization, untouched pre-existing files, granularity).
