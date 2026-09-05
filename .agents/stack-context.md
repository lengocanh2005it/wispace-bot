# Stack Context

Generated: 2026-09-05

## Stack
- **Language**: TypeScript (Node.js 22 in CI; TypeScript 6 package)
- **Framework**: NestJS 11, TypeORM, PostgreSQL; Redis optional via ioredis
- **Build**: npm 10.9.7 workspaces + Turborepo
- **Test**: Jest 30 (`*.spec.ts`), Node test runner for selected smoke scripts
- **Lint**: oxlint (CI gate: yes)
- **Format**: oxfmt (CI gate: yes)

## Secondary Languages
- JavaScript/MJS (operational scripts and database smoke tests)
- Bash/PowerShell (deployment, regression, and local automation scripts)
- SQL (PostgreSQL migrations, repositories, and smoke-test setup)

## Conventions
- Error handling: project-owned error/outcome contracts; map provider/ORM failures at outer boundaries; redact IDs, secrets, and persisted errors.
- Module structure: Turborepo `apps/*` plus framework-agnostic `packages/*`; feature modules use presentation → application → domain ← infrastructure.
- Naming: kebab-case files, PascalCase classes, `*.service.ts`, `*.controller.ts`, `*.repository.ts`, ports/interfaces owned by inner layers.
- Tests: colocated `src/**/*.spec.ts`; app tests use Jest, shared packages use Jest, and root smoke scripts exercise real PostgreSQL/Redis where required.

## CI Gates
- Gitleaks secret scan and pinned-registry executable check.
- Affected/full verification: format check → lint → typecheck → test → build.
- Database bootstrap, migration compatibility, entity-discovery, query-returning-shape, privacy, and reminder-delivery smoke tests.
- Additional guardrail/classifier/eval, dependency-direction, deploy-script, and package-specific workflow checks when paths apply.