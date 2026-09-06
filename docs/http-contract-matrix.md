# HTTP Contract Test Matrix

Request-level HTTP contract tests for Messenger bot endpoints. Tests boot a partial Nest app with mocked dependencies and send real HTTP requests via supertest.

## Coverage

| Endpoint | Method | Auth | Success | Validation | Error | File |
|---|---|---|---|---|---|---|
| `/v1/webhook` | GET | ThrottlerGuard | 200 + challenge string | — | 403 (wrong/missing token) | messenger-webhook.contract.ts |
| `/v1/webhook` | POST | SignatureGuard + ThrottlerGuard | 200 `{ok, accepted, duplicates}` | 400 (missing object), 400 (DTO @ArrayMaxSize) | 404 (non-page object) | messenger-webhook.contract.ts |
| `/v1/messenger/profile/setup` | POST | InternalApiKeyGuard + ThrottlerGuard | 200 `{ok:true}` | — | — | messenger-ops.contract.ts |
| `/v1/messenger/privacy/unlink` | POST | InternalApiKeyGuard + ThrottlerGuard | 200 `{unlinked:true}` | 400 (missing externalUserId), 400 (wrong type) | — | messenger-privacy.contract.ts |
| `/v1/messenger/privacy/delete` | POST | InternalApiKeyGuard + ThrottlerGuard | 200 `{deleted:true}` | 400 (missing externalUserId) | — | messenger-privacy.contract.ts |
| `/v1/messenger/ops/clarification/clear` | POST | InternalApiKeyGuard + ThrottlerGuard | 204 no-content | — | — | messenger-privacy.contract.ts |
| `/v1/messenger/ops/llm-usage/summary` | GET | InternalApiKeyGuard + ThrottlerGuard | 200 `{psid, totalTokens, byFeature}` | userId parsed/ignored | — | messenger-llm-usage.contract.ts |
| `/v1/messenger/ops/llm-usage/fleet` | GET | InternalApiKeyGuard + ThrottlerGuard | 200 `{totalTokens, byFeature}` | date param passed | — | messenger-llm-usage.contract.ts |
| `/health` | GET | None (public) | 200 `{status:"ok"}` | — | Never 503 | shared-health.contract.ts |
| `/health/ready` | GET | None (public) | 200 `{status:"ok"}` | — | 503 (DB down, Redis unreachable, OpsHealth not ready) | shared-health.contract.ts |
| `/health/detail` | GET | InternalApiKeyGuard | 200 `{status, database, redis}` | — | status:"error" with detail | shared-health.contract.ts |

## Running

```bash
# Messenger bot
npm run test:http-contract --workspace=@wispace/messenger-bot

# All contract tests (when Discord/Zalo slices added)
npx turbo run test:http-contract --filter=@wispace/messenger-bot...
```

## Adding new endpoints

1. Create or extend a `.contract.ts` file in `test/http-contract/`
2. Use partial module with `Test.createTestingModule` + mocked deps
3. Override `ThrottlerGuard`, `InternalApiKeyGuard`, and platform-specific guards
4. Set `app.setGlobalPrefix('v1')` to match production route prefix
5. Test: success, auth failure, validation failure, error mapping
6. Update this matrix

## Scope boundaries

- **In scope**: HTTP contract (status, body, headers, guards, validation)
- **Out of scope**: Real DB/Redis (#303), real SQL semantics (#538), DTO audit (#822), WISPACE upstream contracts (#823/#658)
