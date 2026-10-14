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
| `undici@6.28.0` (transitive, via `openai`, `discord.js`) | CVE-2026-19534, CVE-2026-85024, CVE-2026-18540 | 7.5 / 5.9 / 3.7 | All three advisories are WebSocket-specific. `discord.js@14.27.0` reaches WebSocket through `@discordjs/ws` → `ws@8.21.0`, not undici; `openai@7.23.0` uses undici for HTTP fetch. `openai` **peer-requires** `undici >=5 <9` rather than depending on it, and this repo declares its own `undici@^8.11.2` in `apps/messenger-bot` and `packages/wispace-client`, so a top-level `overrides` entry would drag the direct dependency down a major. | `discord.js` and `@discordjs/rest` raising their floor past `6.28.1` — both still declare `^6.27.0` at their latest versions, so this is upstream's to move |

`@grpc/grpc-js` was resolved to 1.14.5 on 2026-10-08 with `npm update
@grpc/grpc-js`, not an override. Worth recording because the mechanism is
counter-intuitive and cost real time to work out: `npm install` honours the
committed lockfile and will not move a locked transitive inside its declared
range, so an available patch sits uninstalled until something forces
re-resolution. Neither `npm install --package-lock-only` nor `--force` does that
either; `npm update <pkg>` does. An `overrides` entry also would not have
helped — the vulnerable 1.14.4 already satisfied the parent's `^1.14.3`, which
is the only reason the lock chose it.

Neither finding is in the CISA KEV catalog (1734 entries at the time of
writing), and EPSS had not scored them — both advisories were published within
two weeks of the scan. On EPSS + KEV triage both are P2/P3, not P0.

## Overrides that do work

| Package | Pinned | Finding it closes |
| --- | --- | --- |
| `multer` | `2.4.0` | CVE-2026-88932, DoS via orphaned disk writes on aborted uploads (moderate). Reached only through `@nestjs/platform-express`, which is unused for uploads here: no `FileInterceptor`, `multipart` or `MulterModule` appears in the tree. Bumped from 2.3.0, which pinned the vulnerable version. multer 2.4.0 also drops `buffer-from`, `concat-stream`, `readable-stream@3` and `safe-buffer`. |

`multer` and `proxy-addr` are overrides rather than lockfile bumps for the
opposite reason: their parents declare ranges that npm can already satisfy
without them, so a plain resolve keeps picking the vulnerable version and only
a pin moves it.
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

An entry without that marker is a no-op, whatever the lockfile looks like. When
an override is not what is wanted, reach for `npm update <pkg>` first — it is
the difference between "the parent already allows the patch" and "the parent
pins below it".