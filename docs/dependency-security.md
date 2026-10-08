# Dependency security

What `npm audit` reports for this repository, which findings are accepted on
purpose, and what closes each one.

## The gate

`npm run audit:check` (`scripts/check-prod-audit.mjs`) fails the
`production-audit` CI job on a **critical** production advisory. It is a separate
job rather than part of `npm run verify`, because `npm audit` needs the network
and the root gate is meant to be runnable offline.

Scope is `--omit=dev`. `deploy/Dockerfile.bot` installs with `npm ci --omit=dev`,
so a dev advisory cannot reach production at all.

Over the whole tree `npm audit` reports 29 advisories. 23 are the
jest/ts-jest dev cluster, and `piscina` (a critical RCE, CVE-2026-102992) is
reached only through `@swc/cli`, so it never lands in an image. Gating on that
raw count would be a gate nobody keeps green.

## Why the threshold is critical and not high

Two production highs are accepted. This is a deliberate lowering of the bar, so
it is written down rather than left to inference — the gate still prints both on
every run, with a pointer here.

| Finding | CVE | CVSS | Why accepted | What closes it |
| --- | --- | --- | --- | --- |
| `undici@6.28.0` (transitive, via `openai`, `discord.js`) | CVE-2026-19534, CVE-2026-85024, CVE-2026-18540 | 7.5 / 5.9 / 3.7 | All three advisories are WebSocket-specific. `discord.js@14.27.0` reaches WebSocket through `@discordjs/ws` → `ws@8.21.0`, not undici; `openai@7.23.0` uses undici for HTTP fetch. `openai` **peer-requires** `undici >=5 <9` rather than depending on it, and this repo declares its own `undici@^8.11.2` in `apps/messenger-bot` and `packages/wispace-client`, so a top-level `overrides` entry would drag the direct dependency down a major. | `openai` and `discord.js` raising their floors past `6.28.1`, then dropping the nested copy |
| `@grpc/grpc-js@1.14.4` (transitive, via `@opentelemetry/sdk-node` → `@opentelemetry/otlp-grpc-exporter-base`) | CVE-2026-101916 | 7.4 | Traces are exported over `@opentelemetry/exporter-trace-otlp-http` (`packages/bot-common/src/tracing.ts`); the gRPC exporter is never instantiated, so `getAuthContext` is never called. A patch exists (1.14.5) but **npm does not apply an override for it in this tree** — verified by `npm ls` reporting no `overridden` marker, and by both the top-level and the parent-scoped override form leaving 1.14.4 on disk through `npm install`, `--package-lock-only` and `--force`. The same override resolves to 1.14.5 in an isolated project, so the form is correct and something about this tree suppresses it. | Drop `sdk-node` for the SDK surface actually used, so the gRPC exporter leaves the tree |

An override that silently does nothing is worse than no override: it reads as a
mitigation while changing nothing. That is why `@grpc/grpc-js` has no
`overrides` entry.

Neither finding is in the CISA KEV catalog (1734 entries at the time of
writing), and EPSS had not scored them — both advisories were published within
two weeks of the scan. On EPSS + KEV triage both are P2/P3, not P0.

## Overrides that do work

| Package | Pinned | Finding it closes |
| --- | --- | --- |
| `multer` | `2.4.0` | CVE-2026-88932, DoS via orphaned disk writes on aborted uploads (moderate). Reached only through `@nestjs/platform-express`, which is unused for uploads here: no `FileInterceptor`, `multipart` or `MulterModule` appears in the tree. Bumped from 2.3.0, which pinned the vulnerable version. multer 2.4.0 also drops `buffer-from`, `concat-stream`, `readable-stream@3` and `safe-buffer`. |
| `proxy-addr` | `2.0.8` | CVE-2026-90711 (CVSS 9.1, CWE-290 auth bypass by spoofing), reached through `express@5.2.1`. Unreachable in practice — `trust proxy` is never enabled, `@nestjs/throttler`'s `getTracker` is overridden to read `X-Real-IP` (`packages/bot-common/src/redis/throttling.ts`), and nothing in the tree reads `req.ip`. Pinned anyway because it is the only critical. Dropping the pin lets npm resolve `express@4.15.5`, which is critical itself and cascades into `@nestjs/core` and `@nestjs/platform-express`. |

## Do not run `npm audit fix` blind

For the jest/ts-jest cluster `npm audit` proposes **`jest@25.0.0`** — a
downgrade from 29.x that breaks the suite. `npm audit fix --force` applies it.

## Adding an override

Confirm it took effect. `npm ls <pkg>` must print `overridden`, and the version
on disk must have moved:

```bash
npm install
npm ls proxy-addr        # expect: proxy-addr@2.0.8 overridden
```

An entry without that marker is a no-op, whatever the lockfile looks like.