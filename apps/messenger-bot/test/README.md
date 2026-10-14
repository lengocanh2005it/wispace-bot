# Messenger tests

Three suites, three different needs:

| Script                       | What it needs                                |
| ---------------------------- | -------------------------------------------- |
| `npm test`                   | nothing — unit tests, all in-memory          |
| `npm run test:http-contract` | nothing — partial apps with mocked providers |
| `npm run test:e2e`           | **a reachable Postgres** (see below)         |

## Why e2e needs a database

`app.e2e-spec.ts` boots the real `AppModule`, so `DatabaseModule` opens a
live TypeORM connection during `app.init()`. Unlike the unit and contract
suites it cannot swap in a fake `DataSource`, which is exactly what makes it
valuable: it proves the whole DI graph resolves and that a referral really
reaches the welcome send.

Redis is not required — the spec sets `CHAT_HISTORY_STORE=memory` and
`CHAT_QUEUE_STORE=memory` so the fail-closed store guards do not trip.

### Start a throwaway Postgres

```bash
docker run -d --name wispace-e2e-pg \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=ai_chat_bot_db -p 55432:5432 postgres:16-alpine

cd apps/messenger-bot
DB_HOST=127.0.0.1 DB_PORT=55432 DB_USER=postgres DB_PASSWORD=postgres \
DB_NAME=ai_chat_bot_db DB_SSL=false DB_ALLOW_INSECURE_HOSTS=127.0.0.1 \
npm run migration:run
```

Then run the suite with the same `DB_*` variables exported, e.g. from PowerShell:

```powershell
$env:DB_HOST='127.0.0.1'; $env:DB_PORT='55432'
$env:DB_USER='postgres';  $env:DB_PASSWORD='postgres'
$env:DB_NAME='ai_chat_bot_db'; $env:DB_SSL='false'
$env:DB_ALLOW_INSECURE_HOSTS='127.0.0.1'
npm run test:e2e
```

`DB_ALLOW_INSECURE_HOSTS` is required because TLS is otherwise enforced for any
host that is not localhost or a private IP.

## Why the e2e Jest config looks like the contract one

NestJS 12 ships as pure ESM (`"type": "module"` in every `@nestjs/*` package).
Jest deliberately refuses to `require()` such files, so the suite must both
transform `@nestjs` out of `node_modules` and resolve the `@messenger/*` path
aliases:

```json
"transform": { "^.+\\.(t|j)s$": "@swc/jest" },
"moduleNameMapper": { "^@messenger/(.*)$": "<rootDir>/../src/$1" },
"transformIgnorePatterns": ["/node_modules/(?!(@nestjs|necord)/)"]
```

This mirrors `test/http-contract/jest-contract.json`. It is **not** a Node
version workaround — Jest throws on ESM-marked files regardless of whether the
runtime supports `require(esm)`, so the suite passes on Node 22 and 24 alike.

## Two timing details the spec handles

- **One app for the whole suite.** Webhook ingestion is fire-and-forget
  (`InlineWebhookInboundDispatcher`), so a per-test app would tear down the
  TypeORM pool while an earlier dispatch is still writing its message log.
- **The welcome log row is awaited.** `sendTextViaPsid` records the send with a
  floating `void repository.logMessage(...)` that nothing awaits, so the spec
  polls `message_logs` instead of assuming the write already landed.
