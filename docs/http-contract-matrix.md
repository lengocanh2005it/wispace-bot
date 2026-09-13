# HTTP Contract Test Matrix

Request-level HTTP contract tests for the three bot HTTP surfaces. Messenger
boots a partial Nest app and sends real requests via supertest; Discord and Zalo
also pin the shared controller contract (status/body forwarding) in their ops
controller suites.

## Coverage

| Endpoint                                | Method | Auth                                 | Success                              | Validation                                    | Error                                                 | Response Schema                                                                            | File                             |
| --------------------------------------- | ------ | ------------------------------------ | ------------------------------------ | --------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------- |
| `/v1/webhook`                           | GET    | ThrottlerGuard                       | 200 + challenge string               | —                                             | 403 (wrong/missing token)                             | `string` (challenge)                                                                       | messenger-webhook.contract.ts    |
| `/v1/webhook`                           | POST   | SignatureGuard + ThrottlerGuard      | 200 `{ok, accepted, duplicates}`     | 400 (missing object), 400 (DTO @ArrayMaxSize) | 404 (non-page), 500 (ingestion failure)               | `{ok: boolean, accepted: number, duplicates: number}`                                      | messenger-webhook.contract.ts    |
| `/v1/messenger/profile/setup`           | POST   | InternalApiKeyGuard + ThrottlerGuard | 200 `{ok:true}`                      | —                                             | 401 (no API key, when configured)                     | `{ok: boolean}`                                                                            | messenger-ops.contract.ts        |
| `/v1/messenger/privacy/unlink`          | POST   | InternalApiKeyGuard + ThrottlerGuard | 200 `status:complete`                | 400 (missing/wrong externalUserId)            | 202 `status:incomplete`; 409 generation conflict      | `{unlinked?, status?, cleanupId?, outstandingStores?}`                                     | messenger-privacy.contract.ts    |
| `/v1/messenger/privacy/delete`          | POST   | InternalApiKeyGuard + ThrottlerGuard | 200 `status:complete`                | 400 (missing/wrong externalUserId)            | 202 `status:incomplete`; 409 generation conflict      | `{deleted, status, cleanupId?, outstandingStores?}`                                        | messenger-privacy.contract.ts    |
| `/v1/discord/privacy/unlink`            | POST   | InternalApiKeyGuard + ThrottlerGuard | 200 complete body forwarded          | 400 (missing/wrong externalUserId)            | 202 incomplete; 409 generation conflict               | Common privacy outcome                                                                     | discord-privacy.contract.spec.ts |
| `/v1/discord/privacy/delete`            | POST   | InternalApiKeyGuard + ThrottlerGuard | 200 complete body forwarded          | 400 (missing/wrong externalUserId)            | 202 incomplete; 409 generation conflict               | Common privacy outcome                                                                     | discord-privacy.contract.spec.ts |
| `/v1/zalo/privacy/unlink`               | POST   | InternalApiKeyGuard + ThrottlerGuard | 200 complete body forwarded          | 400 (missing/wrong externalUserId)            | 202 incomplete; 409 generation conflict               | Common privacy outcome                                                                     | zalo-privacy.contract.spec.ts    |
| `/v1/zalo/privacy/delete`               | POST   | InternalApiKeyGuard + ThrottlerGuard | 200 complete body forwarded          | 400 (missing/wrong externalUserId)            | 202 incomplete; 409 generation conflict               | Common privacy outcome                                                                     | zalo-privacy.contract.spec.ts    |
| `/v1/messenger/ops/clarification/clear` | POST   | InternalApiKeyGuard + ThrottlerGuard | 204 no-content                       | —                                             | —                                                     | _(empty)_                                                                                  | messenger-privacy.contract.ts    |
| `/v1/messenger/ops/llm-usage/summary`   | GET    | InternalApiKeyGuard + ThrottlerGuard | 200 `{psid, totalTokens, byFeature}` | userId parsed/ignored                         | —                                                     | `{psid: string, totalTokens: number, byFeature: Array<{feature: string, tokens: number}>}` | messenger-llm-usage.contract.ts  |
| `/v1/messenger/ops/llm-usage/fleet`     | GET    | InternalApiKeyGuard + ThrottlerGuard | 200 `{totalTokens, byFeature}`       | date param passed                             | —                                                     | `{date: string, totalTokens: number, byFeature: Array<{feature: string, tokens: number}>}` | messenger-llm-usage.contract.ts  |
| `/health`                               | GET    | None (public)                        | 200 `{status:"ok"}`                  | —                                             | Never 503                                             | `{status: "ok"}`                                                                           | shared-health.contract.ts        |
| `/health/ready`                         | GET    | None (public)                        | 200 `{status:"ok"}`                  | —                                             | 503 (DB down, Redis unreachable, OpsHealth not ready) | `{status: "ok" \| "error"}`                                                                | shared-health.contract.ts        |
| `/health/detail`                        | GET    | InternalApiKeyGuard                  | 200 `{status, database, redis}`      | —                                             | status:"error" with detail                            | `{status: string, database: string, redis: string, platform?: object}`                     | shared-health.contract.ts        |

## Running

```bash
# Messenger bot
npm run test:http-contract --workspace=@wispace/messenger-bot

# Messenger request-level contract tests
npm run test:http-contract --workspace=@wispace/messenger-bot

# Discord/Zalo request-level suites (included in their normal Jest runs)
npm test --workspace=@wispace/discord-bot
npm test --workspace=@wispace/zalo-bot
```

## Adding new endpoints

1. Create or extend a `.contract.ts` file in `test/http-contract/`
2. Use `createContractApp()` from `helpers.ts` — passes overrides `InternalApiKeyGuard`, `ThrottlerGuard`, and any additional guards you specify
3. Add extra guard overrides via `overrideGuerts` option (e.g. `MessengerWebhookSignatureGuard`)
4. Test: success, auth failure (when guard is real), validation failure, error mapping
5. Update this matrix with the new endpoint row and response schema

## Scope boundaries

- **In scope**: HTTP contract (status, body, headers, guards, validation)
- **Out of scope**: Real DB/Redis smoke (see [privacy-erasure-verification.md](privacy-erasure-verification.md)), real SQL semantics (#538), DTO audit (#822), WISPACE upstream contracts (#823/#658)
