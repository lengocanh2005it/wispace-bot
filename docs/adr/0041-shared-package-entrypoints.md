---
status: accepted
decided: 2026-09-26
issue: 1126
---

# Shared Package Core and Adapter Entrypoints

Shared packages that separate framework-neutral policy from outer integrations expose explicit `/core` and `/adapters` subpaths; bare roots are not compatibility facades, while adapter-only packages such as `cleanup-cron` expose only `/adapters`. We accept the one-time migration because explicit paths let architecture guards check dependency direction; `reschedule-confirm` gains `/core`, feature exports such as `bot-common` remain outside this rule, and #1126, #1028, and #1088 own entrypoint migration, guard tests, and existing application-edge removal respectively.

## Outcome (#1126)

Option A landed. The ten packages in the entrypoint table publish no `.`
export and no `main`/`types` fallback, so a bare root specifier does not
resolve. `scripts/check-architecture.mjs` enforces this with the
`no-root-package-entrypoint` rule, which also covers `import('pkg').Type`
type queries.

Consequences for the follow-up work:

- #1028 should harden guards against `/core` and `/adapters` specifiers. Its
  original premise — that subpath imports are "already used across the repo"
  and that guards "block the style nobody uses" — was wrong for eight of the
  ten packages; bare roots dominated. That is no longer the case.
- #1088 still owns emptying `LEGACY_APPLICATION_IMPORTS`. #1126 renamed the
  specifiers on the existing edges and recorded four pre-existing edges that
  the old symbol heuristic never matched (`RedisBurstReconciler`,
  `PrivacyStateService`, `ClassifiedError`, and the
  `study-reminder-ownership` functions). The set grew by five rather than
  four: rewriting one `data-quality-cron.service.ts` edge per destination
  subpath split that single entry into two (`ops-health/core` and
  `ops-health/adapters`), so the count also rises by one per split edge. No
  new application-to-adapter edge was introduced.

## Alternatives

Option B (retire the split) was rejected: the guards were already reading
`/core` barrels, and deleting the subpaths would have removed the only
compiler-visible boundary the package set has.
