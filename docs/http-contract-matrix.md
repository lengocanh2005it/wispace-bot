# HTTP Contract Test Matrix

Request-level HTTP contract tests for Messenger bot endpoints. Tests boot a partial Nest app with mocked dependencies and send real HTTP requests via supertest.

## Coverage

| Endpoint | Method | Auth | Success | Validation | Error | Response Schema | File |
|---|---|---|---|---|---|---|---|
| `/v1/webhook` | GET | ThrottlerGuard | 200 + challenge string | — | 403 (wrong/missing token) | `string` (challenge) | messenger-webhook.contract.ts |
| `/v1/webhook` | POST | SignatureGuard + ThrottlerGuard | 200 `{ok, accepted, duplicates}` | 400 (missing object), 400 (DTO @ArrayMaxSize) | 404 (non-page), 500 (ingestion failure) | `{ok: boolean, accepted: number, duplicates: number}` | messenger-webhook.contract.ts |
| `/v1/messenger/profile/setup` | POST | InternalApiKeyGuard + ThrottlerGuard | 200 `{ok:true}` | — | 401 (no API key, when configured) | `{ok: boolean}` | messenger-ops.contract.ts |
| `/v1/messenger/privacy/unlink` | POST | InternalApiKeyGuard + ThrottlerGuard | 200 `{unlinked:true}` | 400 (missing externalUserId), 400 (wrong type) | — | `{unlinked: boolean}` | messenger-privacy.contract.ts |
| `/v1/messenger/privacy/delete` | POST | InternalApiKeyGuard + ThrottlerGuard | 200 `{deleted:true}` | 400 (missing externalUserId) | — | `{deleted: boolean}` | messenger-privacy.contract.ts |
| `/v1/messenger/ops/clarification/clear` | POST | InternalApiKeyGuard + ThrottlerGuard | 204 no-content | — | — | _(empty)_ | messenger-privacy.contract.ts |
| `/v1/messenger/ops/llm-usage/summary` | GET | InternalApiKeyGuard + ThrottlerGuard | 200 `{psid, totalTokens, byFeature}` | userId parsed/ignored | — | `{psid: string, totalTokens: number, byFeature: Array<{feature: string, tokens: number}>}` | messenger-llm-usage.contract.ts |
| `/v1/messenger/ops/llm-usage/fleet` | GET | InternalApiKeyGuard + ThrottlerGuard | 200 `{totalTokens, byFeature}` | date param passed | — | `{date: string, totalTokens: number, byFeature: Array<{feature: string, tokens: number}>}` | messenger-llm-usage.contract.ts |
| `/health` | GET | None (public) | 200 `{status:"ok"}` | — | Never 503 | `{status: "ok"}` | shared-health.contract.ts |
| `/health/ready` | GET | None (public) | 200 `{status:"ok"}` | — | 503 (DB down, Redis unreachable, OpsHealth not ready) | `{status: "ok" \| "error"}` | shared-health.contract.ts |
| `/health/detail` | GET | InternalApiKeyGuard | 200 `{status, database, redis}` | — | status:"error" with detail | `{status: string, database: string, redis: string, platform?: object}` | shared-health.contract.ts |

## Running

```bash
# Messenger bot
npm run test:http-contract --workspace=@wispace/messenger-bot

# All contract tests (when Discord/Zalo slices added)
npx turbo run test:http-contract --filter=@wispace/messenger-bot...
```

## Adding new endpoints

1. Create or extend a `.contract.ts` file in `test/http-contract/`
2. Use `createContractApp()` from `helpers.ts` — passes overrides `InternalApiKeyGuard`, `ThrottlerGuard`, and any additional guards you specify
3. Add extra guard overrides via `overrideGuerts` option (e.g. `MessengerWebhookSignatureGuard`)
4. Test: success, auth failure (when guard is real), validation failure, error mapping
5. Update this matrix with the new endpoint row and response schema

## Scope boundaries

- **In scope**: HTTP contract (status, body, headers, guards, validation)
- **Out of scope**: Real DB/Redis (#303), real SQL semantics (#538), DTO audit (#822), WISPACE upstream contracts (#823/#658)
