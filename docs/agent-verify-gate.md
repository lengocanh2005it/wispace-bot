# The verify gate, the guards, and where a new check lives

Implementation-time companion to the review checklist in
[`CODING_STANDARDS.md`](../CODING_STANDARDS.md) (which says _which_ rule exists)
and to the always-loaded gate commands in [`AGENTS.md`](../AGENTS.md).

## One gate

`scripts/verify.mjs` is the single root-owned definition. Three invocations:

```bash
npm run verify            # full gate
npm run verify:affected   # PR variant: root checks always, turbo tasks limited to affected workspaces
npm run verify -- --force # uncached full pass (the scheduled run)
```

CI sets `TURBO_SCM_BASE` for pull requests. The gate runs guard tests, the
repository checks, formatting, lint, dependency checks, then Turbo
typecheck/test/build. Nothing else is a substitute for it: a targeted
`npx turbo run test --filter=…` proves one workspace, not the gate.

App workspace test scripts use `jest --forceExit --maxWorkers=50%`. Most package
scripts use `jest --maxWorkers=50%` without `--forceExit`; some packages differ, so
check the target workspace's `package.json` when diagnosing open handles.
Messenger's `npm run test:e2e` needs a real PostgreSQL and is outside the gate.

The database smokes need `NODE_ENV=test` and a loopback `DB_HOST` (CI sets
`DB_ALLOW_INSECURE_HOSTS=postgres` for them); they are not part of the gate and
never touch production:

```bash
npm run database:bootstrap-smoke            # entity metadata + OAuth cleanup
npm run database:query-returning-shape-smoke # #754 raw query() UPDATE/DELETE tuple vs INSERT flat shapes
npm run database:privacy-smoke              # legacy registry unlink/delete/export
npm run database:persistence-semantics-smoke # #538/#849 lease fencing, inbox isolation, quota idempotency, delete atomicity
npm run database:migration-compatibility    # canonical chain + bot tables
```

## Where a new check goes

A guard that needs an installed dependency (e.g. `typescript`) belongs in the
gate, **not** in CI job `deploy-scripts-test`: that job runs with no `npm ci`,
so any `require()` of a devDependency fails it on every push. Wire it as a
`package.json` script plus a `ROOT_VERIFY_SCRIPTS` entry, and list it in
`scripts/verify.test.mjs`. Aliasing a gate script to a file outside `scripts/` is
already the pattern — `prove-checks:test` points into `.claude/skills/`.

Belt-and-braces: every guard ships a red-path test beside it
(`scripts/check-*.test.mjs`, `.github/scripts/tests/*.test.sh`) so the failure
mode is exercised without the real violation.

**Startup config constraints follow the same rule.** Extend a collector —
`collectCommonStartupViolations` / `collectLlmStartupViolations` in the apps,
`createStartupValidationRunner` in `@wispace/bot-common/config` — not
`vps-deploy.sh`. Producer descriptors live next to the report crons
(`report-producer.ts`) and are imported by the validator, so preflight and
runtime cannot disagree. A per-app inventory spec fails when a
`*_SEND_CONCURRENCY` key is read without a matching probe, so renaming or adding
such a key means updating that list. The phase runs on the monitoring network
only (it reaches no database, Redis or vendor API) and deliberately does not
boot the DI graph: `preview: true` instantiates nothing, while
`createApplicationContext` would start a second queue worker against live Redis
while the old container still serves. Full rationale: `docs/project-overview.md`
§12 startup validation + [ADR-0054](adr/0054-startup-validation-runs-before-the-release-container.md).

## Guards whose rule is not self-evident

The rule each guard enforces is in `CODING_STANDARDS.md`. What follows is the part
a reader cannot infer from the guard's name.

**Entrypoint consumer (#1440).** A declared `exports` subpath that nothing
imports reads as a supported API and rots silently. Two cases that look alike in
the manifest: a subpath that **publishes symbols** nothing imports is a
violation; a subpath that **publishes nothing** — the placeholder
`@wispace/account-link-core/adapters` — is a note and allowed, because importing
it yields nothing and cannot mislead. Specs count as consumers; a commented-out
import does not; an unresolvable entry target is a violation rather than assumed
empty. No exemption list: an entry here is exactly the permanent exemption this
repository refuses elsewhere. #1440 removed one by hand and measuring for the
rule found a second the same day.

**Dependency placement in `packages/*` (#1219).** A package in `packages/*`
belongs in `devDependencies` unless the compiled output needs it at runtime:
build-only tooling (Nest CLI, schematics, testing, compilers, formatters) in
`dependencies` ships into all three production images, because
`deploy/Dockerfile.bot` installs with `npm ci --omit=dev` and `--omit=dev` only
drops what is _declared_ as a dev dependency. `npm run manifest-deps:check` fails
a declared-but-unimported runtime dependency, so move it to `devDependencies`
or delete it. Three traps:

1. A **type-only** import still does not license removal. `@wispace/bot-common`
   calls `NestFactory.create`, which resolves the HTTP platform through a dynamic
   `import('@nestjs/platform-express')` that `process.exit(1)`s without the
   adapter (comment at `src/bootstrap/bot-bootstrap.ts`).
2. The lint governs **direct declarations only**. `typeorm` declares `typescript`
   and `ts-node` as optional peers, so the `rm -rf` of those two in
   `deploy/Dockerfile.bot` stays load-bearing. Removing either guard because the
   other covers it is wrong in both directions.
3. `deploy/runtime-image-check.mjs` matches **scoped** forbidden names at any
   depth and **unscoped** names (`typescript`, `ts-node`, `jest`) only at the
   `node_modules` root — an unscoped name is too generic to assert at depth. Both
   behaviours are pinned by `npm run runtime-image:test`.

**`knip:deps` cannot cover that second trap.** knip skips an undeclared import
whenever the imported package is a workspace package and the importing workspace
is `private` (`knip/dist/DependencyDeputy.js:148`) — true of every workspace
here — so it reports zero unlisted no matter how many exist, and `--strict`
(drops the spec entry points `knip.json` relies on) still reports nothing. The
failure is invisible by construction: root `node_modules` symlinks every
workspace and a whole-repo build compiles every package regardless of the graph,
so an undeclared import resolves until a declared-graph build
(`--filter=@pkg^...`) runs on a clean checkout. Fix by declaring the package in
that workspace's `package.json`; root `scripts/` is out of scope by design
(approved tooling imports).

**File size is a ratchet (#778), not a gate.** `npm run file-size:report`
renders the tracked-file baseline table, so it is generated rather than retyped.
Each entry is a decision: the check rejects an entry missing a bounded context, a
tracking issue, or a reason. A tracked file may not grow; a new file is never
gated by size; a file that shrinks keeps the higher ceiling. ADR-0044 records why
the 780-line threshold it replaced was retired.

**Metric registry (#1381).** `npm run metric-registry:check` is an AST guard
against a module-scope `prom-client` metric with no per-app `registers` — the
failure it prevents is a duplicate registration at import time.

**Shared dependency versions (#757).** `npm run dep-versions:check` fails a
package declared at two incompatible majors across workspaces. `packages/learner-profile`
sat on `typeorm: ^0.3.20` while every other database-touching workspace sat on
`^1.1.0`; disjoint ranges mean npm cannot hoist one copy, so it nests a second
under that workspace and one process loads two ORMs. Nothing surfaces as a clean
error — entity metadata and decorator registries are per-copy, so `instanceof`
fails across the boundary, and a TypeORM upgrade stops being one change. The
compat axis is `major` above zero and `0.minor` at it, because for `0.y` the
minor is the breaking axis. Only `^major.minor.patch` is *provably* safe once two
declarations share an axis — any two caret ranges inside one major always
intersect — so a `~`, a partial version or an alias on a shared dep is reported
as unverified rather than passed in silence. Detecting a genuinely disjoint
same-major pair needs a real solver, and `semver` is not a root dependency, so
the rule stops at reporting. All 241 shared declarations in the repo are
`^major.minor.patch` today, which makes the rule exact for this tree rather than
merely untriggered. Three limits worth knowing:

1. It compares **ranges, not installed trees**. "Exactly one installed copy" is
   false on a healthy tree — `@types/node` and `undici` each resolve to two
   versions because a third-party package pins the older one — so a lockfile
   rule would fail on transitives this repo does not control.
2. It fails **only** on a major mismatch. A same-major disjoint pair (`~1.2.0`
   beside `~1.5.0`) nests a copy and is listed as unverified, not failed — the
   check stays green there on purpose, so an unusual pin surfaces without
   blocking work.
3. `devDependencies` are included because a drifted dev declaration nests the
   same way: root holds `typeorm` there. `dependencies` alone would have missed
   the shape of #757 itself.

**Production dependency audit.** `npm run audit:check` runs `npm audit --omit=dev`
and fails the `production-audit` CI job on a **critical** advisory. It is a
separate job rather than a `ROOT_VERIFY_SCRIPTS` entry because it needs the
network and the root gate must stay runnable offline. The threshold is critical
rather than high on purpose: one production high is accepted with written
justification, and the gate still prints it on every run. Overrides are confirmed
by `npm ls <pkg>` reporting `overridden`. Findings, accepted exceptions, the "do
not run `npm audit fix` blind" warning, and the `npm update` versus `overrides`
distinction are in `docs/dependency-security.md`.

**Deployment scripts are regression-tested.** `vps-deploy.sh` and
`vps-self-pull-deploy.sh` behaviour is pinned by
`.github/scripts/tests/vps-deploy.test.sh` and
`.github/scripts/tests/vps-self-pull-deploy.test.sh` in CI job
`deploy-scripts-test`. Editing either script means editing its test.

**Import-boundary guards run on JavaScript too.** `npm run architecture:check`
scans operational scripts, not only TypeScript.

## Common CI pitfalls

| Symptom                                                            | Cause                                                                                                              | Fix                                                                                                                                                                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jest passes locally, CI hangs then fails ~30s                      | `setInterval` / long `setTimeout` never cleared → open handle                                                      | implement `OnModuleDestroy` and clear in `onModuleDestroy()`                                                                                                                                                    |
| `oxfmt --check` fails where local reports clean                    | CRLF checkout, formatter expects LF                                                                                | `npm run format`                                                                                                                                                                                                |
| `oxlint` reports `no-useless-escape`                               | `\/` or `\-` inside a character class                                                                              | `[/-]`                                                                                                                                                                                                          |
| `rg` exits 0 with no output on a pattern you can see               | a regex metacharacter `( [ * + ? \| \` stopped it matching                                                         | `rg -F`                                                                                                                                                                                                         |
| Tests pass locally, fail CI on dates                               | CI runs UTC, local UTC+7                                                                                           | `new Date()` or mock `Date.now`                                                                                                                                                                                 |
| `knip:deps` dies with `RangeError: Array buffer allocation failed` | free RAM, not a heap cap — same `--max-old-space-size=8192` run passes with memory free and fails below ~2 GB free | free memory and re-run; a heap flag creates no RAM. `verify` runs this gate green in CI, so treat it as a local-machine limit. Per-`--workspace` scoping would cut peak memory but changes the gate's semantics |

**Timer rule.** `collectDefaultMetrics()` from `prom-client`, any `setInterval`,
or a long `setTimeout` in a service means implementing `OnModuleDestroy` and
clearing there; a `prom-client` Registry also needs `this.registry.clear()` on
destroy.

## Tests that must follow a change

| Change                               | Spec                                      |
| ------------------------------------ | ----------------------------------------- |
| `remind_at` calculation              | `study-reminder-schedule.service.spec.ts` |
| job upsert when the schedule changes | `study-reminder-job.repository.spec.ts`   |
| ops API guard                        | `internal-api-key.guard.spec.ts`          |
| `ref` parsing / `m.me` link          | `poc.constants.spec.ts`                   |
| webhook event routing                | `messenger-webhook.router.spec.ts`        |

Specs live at `apps/*/src/**/*.spec.ts` and `packages/*/src/**/*.spec.ts`; run
`npm run test --workspace=<workspace>` for a focused workspace run. Workspace
scripts vary: check that workspace's `package.json` before calling `verify:local`
or another package-scoped command. TypeORM `migration:run|revert|show` scripts are
Messenger-only and run from `apps/messenger-bot/`.
Eval-harness specs have their own branch — see
[`agent-llm-and-chat.md`](agent-llm-and-chat.md).
