---
status: accepted
---

# Keyset paging over platform mappings goes through one port in `bot-common/utils`

Five call sites walk platform mappings by keyset cursor: the three 08:00 report crons (`apps/messenger-bot/.../report-cron.service.ts:172-243`, `apps/discord-bot/.../discord-report-cron.service.ts:127-217`, `apps/zalo-bot/.../zalo-report-cron.service.ts:128-187`), the study-reminder full sync (`packages/study-reminder-shared/src/services/study-reminder-sync.service.ts:163-200`), and platform-link state reconciliation (`packages/database/src/services/account-linking/platform-link-state.service.ts:313-348`). Each hand-rolled its own cursor loop. They will instead share one framework-free iterator consuming one port: `fetch(cursor: TCursor | undefined, limit: number) => Promise<{ items: TItem[]; nextId?: TCursor }>`, hosted in `packages/bot-common/src/utils/`. Two properties of that signature are load-bearing rather than incidental — `nextId` instead of a bare array, and a generic cursor type — and both are justified below.

## Why the port, not the loop

The duplication is not the six-line `while`. The five read adapters disagree on nearly everything that matters:

| site | signature | returns | cursor |
| --- | --- | --- | --- |
| Messenger | `(afterId: number, limit: number)` | bare array | number |
| Discord | `(cursor: string \| undefined, limit, options?)` | bare array | string |
| Zalo | no port — private `loadPage`, bakes its own `PAGE_SIZE` | bare array | string |
| Reminder | `(platform, {afterId, limit})` | `{ items, nextId }` | string |

number-vs-string, three bare arrays against one `{ items, nextId }`, positional limit against named options, a port against a private method. An iterator that shares only the loop leaves every one of those in place, so each adapter re-derives its own termination rule and the divergence recurs — which is precisely the drift this work exists to remove. The shared unit has to be the contract.

## `nextId`, not a bare array

Three sites returned a bare array and inferred "last page" from the page length. They inferred it in three different ways: Messenger broke on `page.length < PAGE_SIZE`, Discord and Zalo on `rawPageLen === PAGE_SIZE`. Every one of them reached the same conclusion — a short page is exhausted, a full page is not — so no delivery behaviour was wrong. What was wrong was that each site re-derived the rule for itself, which is exactly the drift the port removes.

The rule itself is also terminology this repo has already settled. `CONTEXT.md` defines **result completeness** as "`incomplete` or `unknown`; returned count alone does not prove completeness", with `_Avoid_: returned count, has-more inference`, and **known remaining data** as records the source confirms exist beyond the returned page, "cannot be inferred merely by reaching the cap", with `_Avoid_: hasMore`. So the port must never *claim* that records remain — that would be reaching the cap and calling it knowledge.

A full page therefore declares a continuation as a **refusal to claim exhaustion**, not as an assertion that more rows exist. `CONTEXT.md` calls that completeness `unknown`, and `unknown` is a legitimate answer; only a claim of existence would have been the forbidden inference. Inferring exhaustion from a short page is sound, because a `LIMIT n` query returning fewer than `n` rows is proof. `rawPageLen === PAGE_SIZE` was the forbidden half: it assumed more rows existed and only then fetched to find out.

`nextId` is what **known remaining data** looks like as an API: the source states whether it is done instead of the consumer guessing from a count. It is already the shape `study-reminder-shared` uses, so that package changes least. The cost is that a full page pays one extra empty fetch — one query in a daily cron.

## A generic cursor, not `string`

Messenger's `user_platform_mappings` primary key is numeric; Discord's and Zalo's are strings. Normalising on `string` would make Messenger's adapter stringify a number and parse it back through `Number(cursor)`. A malformed cursor then yields `NaN`, `id > NaN` matches zero rows, and the report wave **silently truncates** — no error, no log, learners simply not contacted. `TCursor` is erased at runtime and costs one type argument per call site, so it buys the absence of that path for free. Silently under-delivering a morning report is not a tradeoff this system makes.

## Why `bot-common/utils` and not `scheduler-core`

`packages/scheduler-core` is the intuitive home — it already holds `runBatched` (`src/utils/batch.utils.ts`), the closest existing sibling, and three of the five call sites already import it. It is forbidden.

`scripts/check-architecture.mjs` sets `DATABASE_FORBIDDEN_DEPENDENCIES = ['@wispace/reschedule-confirm', '@wispace/scheduler-core', '@wispace/bot-metrics']` and fails any `packages/database/**` import of those under rule `database-no-domain-dependency`. That check runs over `packages/database/src`, over `packages/database/package.json`, and over the lockfile, so the edge cannot be reintroduced by a manifest edit either. `scheduler-core` additionally declares `@wispace/database` itself, which would make the relationship bidirectional. The fifth call site lives in `packages/database`, so wherever the helper lands must be importable from there.

`@wispace/bot-common` is deliberately absent from that list. It is declared by all five consumers, so no manifest or lockfile change is needed, and `packages/bot-common/src/utils/` is already framework-free in practice — its only imports are `node:crypto` and intra-barrel relatives, no `@nestjs/*`, `typeorm`, or `ioredis` — and already holds this exact shape in `jitteredDelayMs`, `sleep`, and `extractQueryRows`.

Two mechanical constraints follow and will bite anyone adding a sixth call site: import the **subpath** `@wispace/bot-common/utils` (the bare root is blocked by `ROOT_SPECIFIER`; `packages/bot-common/src/index.ts` is a dead barrel), and use a **named import** for a symbol not ending in `Entity|Repository|Service|Controller|Gateway|Adapter|ApiClient|Client|RedisStore|Cache|RateLimiter`, or messenger and discord `application/**` trip `mixed-import-unclassifiable`.

## Not `@wispace/contracts`

Legally permitted — that package's only rule is `contracts-core-no-imports`, which a no-import generator satisfies — and rejected on taxonomy. ADR-0043 scopes `contracts` to shared kernel vocabulary: a cause taxonomy that a deciding, an applying, and a recording context all read. A paging iterator is a utility. `Platform`, `MessageType`, and `PLATFORM_STORAGE` are read across contexts; `iterateMappingPages` is read by whoever needs to walk a mapping table. Putting a utility in the vocabulary package erodes what that package is for.

## Rejected alternatives

- **Share only the loop** (`forEachPage(fetch, onPage, pageSize)`). Smaller diff, no port work, and Zalo stays portless and untestable. Rejected: it relocates the divergence instead of removing it, and leaves the one site with no assertions still unassertable.
- **A new `@wispace/paging` package.** Tidier taxonomy, but five manifest edits, a lockfile change, and turbo wiring to hold one file. A directory maintained forever for one function.
- **Unify page size onto 100.** The original framing of #1142 asserted 100 everywhere; reading the code showed 500 (Messenger), 200 (Discord, Zalo), 100 (reminder). Page size stays a per-call-site config. Unifying it is a separate decision, and migration `1789093300000` already added `idx_platform_mappings_platform_status_id`, so the query shape is not what constrains it.
- **Continue-on-error on a failed page fetch.** Converts a loud wave-wide abort into a silent skip, which contradicts both `result completeness` and #1142's own acceptance criteria. Page errors still throw. The durable resume cursor that all five sites lack is tracked as separate debt and is not addressed here.

## Consequences

- A sixth keyset-paging call site should consume this port rather than open a loop. If a new scan needs different semantics — reverse order, a key other than `id` — it should be a deliberate new decision, not an ad-hoc loop.
- `nextId` becomes the only accepted termination signal. A future adapter that returns a bare array reintroduces the exact divergence this removes, and the specs are what catch it.
- The port is a plain function argument, not an injected DI token. Zalo's page loader therefore stays a private method with the port's signature and is handed to the iterator as a source object, rather than becoming an injectable provider. Nothing else in Zalo consumes it, and a token plus module wiring would buy one caller nothing; if a second consumer appears, promoting it to DI is a small change.
- The D/Z tables still lack the `(platform, status, id)` keyset index that `1789093300000` added for `user_platform_mappings` (#1480). That is a measured question about index cost, independent of this decision.
- Page-fetch failure still aborts the whole wave with no durable resume cursor: already-sent users stay sent, unsent users are not reached. Deliberately unchanged here, and recorded as open debt rather than papered over.
