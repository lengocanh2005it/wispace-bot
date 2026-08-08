# Security Audit Report — wispace-bot Monorepo

**Date:** 2026-08-08
**Scope:** All apps (messenger-bot, discord-bot, zalo-bot) and 17 shared packages
**Auditor:** AI Security Audit Agent

---

## Executive Summary

The wispace-bot monorepo demonstrates **strong security fundamentals** in its core authentication, cryptographic, and database layers. However, several **medium-severity gaps** exist in HTTP security headers, input validation, and health endpoint exposure.

### Top 5 Critical Findings

| # | Severity | Finding | Impact |
|---|----------|---------|--------|
| 1 | **HIGH** | No Helmet/security headers middleware | Missing CSP, HSTS, X-Frame-Options leaves apps vulnerable to clickjacking, MIME sniffing, and other browser-based attacks |
| 2 | **HIGH** | No global ValidationPipe / DTO validation | Incoming request bodies are not schema-validated; malformed or malicious payloads reach business logic unchecked |
| 3 | **MEDIUM** | Health endpoints expose DB/Redis connection status without auth | `/health` and `/health/redis` leak infrastructure details to unauthenticated callers |
| 4 | **MEDIUM** | PSIDs logged in error messages and dead-letter entries | Platform user identifiers are persisted in plaintext logs and dead-letter tables |
| 5 | **MEDIUM** | Metrics endpoints unprotected in some configurations | `/metrics` (Prometheus) can leak operational metrics to unauthorized parties |

---

## Findings Table

| ID | Severity | Category | File(s) | Description |
|----|----------|----------|---------|-------------|
| A-01 | HIGH | HTTP Security | `apps/*/src/main.ts` | No Helmet middleware — missing security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy) |
| A-02 | HIGH | Input Validation | `apps/*/src/main.ts` | No global `ValidationPipe` — no DTO/class-validator validation on any endpoint |
| A-03 | MEDIUM | Auth | `packages/bot-common/src/health.controller.ts:30-78` | `/health` and `/health/redis` endpoints are unprotected — expose DB and Redis connection status |
| A-04 | MEDIUM | Data Exposure | `apps/messenger-bot/src/modules/messenger/application/services/messenger.service.ts:79-82` | PSIDs logged in webhook error messages and dead-letter entries |
| A-05 | MEDIUM | Auth | `packages/bot-metrics/src/metrics.module.ts:50` | `/metrics` endpoint unprotected — Prometheus metrics visible to unauthorized callers |
| A-06 | LOW | Config | `apps/*/src/main.ts` | `HTTP_JSON_BODY_LIMIT` configurable via env — could be set to unsafe values |
| A-07 | INFO | Crypto | `packages/bot-common/src/internal-api-key.guard.ts:9,36` | ✅ `timingSafeEqual` used correctly for API key comparison |
| A-08 | INFO | Crypto | `apps/messenger-bot/src/shared/common/utils/messenger-webhook-signature.utils.ts:47` | ✅ HMAC-SHA256 with `timingSafeEqual` for Meta webhook verification |
| A-09 | INFO | Crypto | `apps/zalo-bot/src/modules/zalo-webhook/application/utils/zalo-webhook-signature.utils.ts:36-47` | ✅ SHA-256 with `timingSafeEqual` for Zalo webhook verification |
| A-10 | INFO | Injection | `packages/llm-agent/src/utils/prompt-injection.utils.ts` | ✅ Comprehensive LLM prompt injection defenses with confusable normalization |
| A-11 | INFO | SQL | `packages/chat-metering/src/chat-rate-limit/chat-rate-limit.repository.ts` | ✅ All raw SQL uses parameterized queries (`$1`, `$2`, etc.) |
| A-12 | INFO | Concurrency | `packages/bot-common/src/pg-advisory-lock.service.ts` | ✅ PostgreSQL advisory locks used correctly for leader election |
| A-13 | INFO | Concurrency | `packages/chat-queue-core/src/debounce-chat-queue.ts` | ✅ Chat queue properly implements `OnModuleDestroy` cleanup |
| A-14 | INFO | Secrets | `.gitignore:2-3` | ✅ `.env` and `.env.shared` properly gitignored |
| A-15 | INFO | Auth | `apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-account-link.service.ts:31` | ✅ PKCE used for Zalo OAuth (RFC 7636) |
| A-16 | INFO | Auth | `apps/messenger-bot/src/shared/common/guards/messenger-webhook-signature.guard.ts:27-33` | ✅ Production failsafe — rejects unsigned webhooks outside test runtime |
| A-17 | INFO | Injection | `apps/messenger-bot/src/shared/utils/llm-json-output.utils.ts` | ✅ LLM JSON output parsed + shape-validated before use |
| A-18 | INFO | Data Integrity | `packages/chat-metering/src/chat-rate-limit/chat-rate-limit.repository.ts:77-123` | ✅ Idempotency key handling prevents duplicate rate-limit reservations |
| A-19 | INFO | Resilience | `packages/database/src/services/platform-dead-letter.service.ts` | ✅ Dead-letter queue captures failed webhook events for retry |
| A-20 | INFO | Secrets | `apps/messenger-bot/src/modules/scheduler/application/services/doppler-runtime-sync.service.ts:282` | ✅ Doppler sync writes `.env` with mode `0o600` (owner-only) |

---

## Detailed Findings

### A-01: No Helmet Security Headers Middleware

**Severity:** HIGH
**Category:** HTTP Security
**Files:** `apps/messenger-bot/src/main.ts`, `apps/discord-bot/src/main.ts`, `apps/zalo-bot/src/main.ts`

**Description:**
None of the three apps use the `helmet` middleware or manually set security headers. This leaves responses without:
- `Content-Security-Policy` (CSP)
- `Strict-Transport-Security` (HSTS)
- `X-Frame-Options` (clickjacking protection)
- `X-Content-Type-Options` (MIME sniffing protection)
- `Referrer-Policy`
- `Permissions-Policy`

**Impact:**
- Clickjacking via iframe embedding
- MIME type confusion attacks
- No forced HTTPS via HSTS
- Missing CSP allows inline script injection

**Fix:**
```typescript
// In each app's main.ts, after NestFactory.create():
import helmet from 'helmet';
app.use(helmet());
```
Or set specific headers manually if Helmet is not desired:
```typescript
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
```

---

### A-02: No Global ValidationPipe / DTO Validation

**Severity:** HIGH
**Category:** Input Validation
**Files:** All `apps/*/src/main.ts`, all controller files

**Description:**
No `ValidationPipe` is configured globally, and no DTOs with `class-validator` decorators are used anywhere in the codebase. Incoming request bodies reach controller methods without schema validation.

**Impact:**
- Malformed or oversized payloads reach business logic
- Type coercion issues (e.g., `userId` as string vs number)
- Missing required fields not caught at the HTTP layer
- Potential for unexpected data shapes causing runtime errors

**Observation:**
The codebase does use manual validation in some controllers (e.g., `scheduler.controller.ts:82-91` validates `userId` as a positive number). However, this is ad-hoc and inconsistent.

**Fix:**
```typescript
// In each app's main.ts:
import { ValidationPipe } from '@nestjs/common';
app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
```
Then add DTOs with decorators:
```typescript
import { IsNumber, IsPositive, IsOptional, IsString } from 'class-validator';
class SyncStudyCalendarBody {
  @IsNumber()
  @IsPositive()
  userId: number;
}
```

---

### A-03: Health Endpoints Expose Infrastructure Details Without Auth

**Severity:** MEDIUM
**Category:** Auth / Information Disclosure
**File:** `packages/bot-common/src/health.controller.ts:30-78`

**Description:**
The `/health` and `/health/redis` endpoints are not protected by `InternalApiKeyGuard`. They expose:
- Database connection status (`connected` / `disconnected`)
- Redis connection status (`connected` / `disabled` / `unreachable`)

**Impact:**
- An attacker can probe whether the database or Redis is reachable
- Status changes could reveal operational state (e.g., during attacks or maintenance)
- Load balancer health checks are legitimate use case, but the detailed error info should be restricted

**Fix:**
Option 1: Keep health endpoints unauthenticated but remove detail on failure:
```typescript
// Return generic "error" without connection details to unauthenticated callers
if (result.status === 'error') {
  throw new ServiceUnavailableException({ status: 'error' });
}
```

Option 2: Add a lightweight auth check for detailed health:
```typescript
@Get('health/detail')
@UseGuards(InternalApiKeyGuard)
async detailedCheck() { /* ... */ }
```

---

### A-04: PSIDs Logged in Error Messages and Dead-Letter Entries

**Severity:** MEDIUM
**Category:** Data Exposure / PII
**Files:**
- `apps/messenger-bot/src/modules/messenger/application/services/messenger.service.ts:79-82`
- `apps/messenger-bot/src/modules/messenger/application/services/messenger-link-context.service.ts:51`
- `apps/messenger-bot/src/modules/messenger/application/services/webhook-action-executor.service.ts:57`
- Dead-letter tables (`messenger_webhook_dead_letter`, `platform_dead_letter`)

**Description:**
Messenger PSIDs (Platform-scoped User IDs) are logged in plaintext in:
- Webhook error messages: `Webhook event for PSID ${event.sender?.id} failed`
- Dead-letter entries: `psid: event.sender?.id`
- Link verification errors: `psid=${psid}`

While PSIDs are not high-entropy secrets (they are visible in message URLs), they are persistent user identifiers tied to Facebook accounts.

**Impact:**
- Log aggregation systems may retain PSIDs longer than necessary
- Dead-letter tables store PSIDs alongside raw payloads
- Correlating PSIDs across logs could enable user tracking

**Fix:**
- Hash PSIDs before logging: `sha256(psid).slice(0, 12)` for correlation without exposure
- Or use a truncated/masked form: `psid=${psid.slice(0, 4)}...${psid.slice(-4)}`
- Consider retention policies for dead-letter tables

---

### A-05: Metrics Endpoints Unprotected

**Severity:** MEDIUM
**Category:** Auth / Information Disclosure
**File:** `packages/bot-metrics/src/metrics.module.ts:50`

**Description:**
The `/metrics` endpoint (Prometheus format) is exposed without authentication in some configurations. While the `BotMetricsService` has `@UseGuards(InternalApiKeyGuard)` in its controller, the health controller in `bot-common` is shared and may be mounted differently.

**Impact:**
- Prometheus metrics can reveal request rates, error rates, queue depths, and LLM usage
- Could assist an attacker in understanding system behavior and finding weaknesses

**Fix:**
Ensure all `/metrics` endpoints are behind `InternalApiKeyGuard` consistently across all apps.

---

### A-06: Body Parser Limit Configurable via Environment Variable

**Severity:** LOW
**Category:** Configuration
**File:** `apps/messenger-bot/src/main.ts:27-29`

**Description:**
`HTTP_JSON_BODY_LIMIT` is read from `process.env` and defaults to `256kb`. If set to a very large value, it could enable memory exhaustion via large payloads.

**Impact:**
- Misconfiguration could allow extremely large request bodies
- Default of `256kb` is reasonable

**Fix:**
Add a maximum cap:
```typescript
const rawLimit = process.env.HTTP_JSON_BODY_LIMIT?.trim() || '256kb';
const bodyLimit = Math.min(parseBytes(rawLimit), 1024 * 1024); // Cap at 1MB
```

---

## Positive Security Findings

### Cryptographic Practices (EXCELLENT)

| Practice | Location | Notes |
|----------|----------|-------|
| Timing-safe comparison | `internal-api-key.guard.ts:36` | `timingSafeEqual` for API key comparison |
| HMAC-SHA256 webhook sig | `messenger-webhook-signature.utils.ts:12,47` | Meta webhook verification with timing-safe compare |
| SHA-256 webhook sig | `zalo-webhook-signature.utils.ts:36-47` | Zalo webhook verification with timing-safe compare |
| PKCE for OAuth | `zalo-account-link.service.ts:31-36` | `randomBytes(32)` + SHA-256 code challenge |
| Secure random tokens | `discord-pending-join.service.ts:24` | `randomUUID()` for pending join tokens |
| OAuth state tokens | `zalo-oauth-state.service.ts:28` | `randomBytes(24).toString('hex')` |

### SQL Injection Prevention (EXCELLENT)

All raw SQL queries across the codebase use parameterized queries:
- `chat-rate-limit.repository.ts`: 15+ parameterized queries
- `llm-usage.repository.ts`: 4+ parameterized queries
- `typeorm-study-reminder-job.repository.ts`: 3+ parameterized queries
- `pg-advisory-lock.service.ts`: All queries parameterized

No string interpolation or concatenation was found in any SQL query.

### LLM Prompt Injection Defenses (EXCELLENT)

`packages/llm-agent/src/utils/prompt-injection.utils.ts` implements comprehensive defenses:

1. **Length limits**: `MAX_USER_TEXT_LENGTH = 2000`, `MAX_UNTRUSTED_TEXT_CHARS = 1000`
2. **Pattern detection**: 20+ regex patterns for instruction override, persona override, extraction, delimiter injection
3. **Unicode confusable normalization**: Cyrillic/Greek lookalikes mapped to Latin equivalents
4. **Repetition flood detection**: Blocks token-overflow attacks via repeated text
5. **Control character stripping**: Removes unsafe control characters
6. **Tool result sanitization**: `sanitizeToolResultContent()` recursively sanitizes nested JSON

### Concurrency & Race Conditions (GOOD)

- **Advisory locks**: `pg_advisory_xact_lock` used for serialized upserts and rate-limit transactions
- **Session-level locks**: `PgAdvisoryLockService` for leader election with proper acquire/release lifecycle
- **Redis distributed locks**: `RedisChatQueueStore` uses per-PSID locks with UUID-based ownership
- **Idempotency**: Chat rate limit uses `chat_idempotency` table with `ON CONFLICT DO NOTHING`
- **Debounce queue**: `DebounceChatQueue` properly implements `OnModuleDestroy` cleanup

### Secret Management (GOOD)

- `.env` and `.env.shared` are gitignored
- All secrets read via `ConfigService` (NestJS DI)
- Doppler integration for production secrets
- `.env` files written with mode `0o600` (owner-only read/write)
- No hardcoded secrets found in source code

### Webhook Security (GOOD)

- Meta webhook: HMAC-SHA256 signature verification with `rawBody` (not parsed body)
- Zalo webhook: SHA-256 signature + timestamp freshness check (5-minute window)
- Production failsafe: unsigned webhooks rejected outside test runtime
- Dead-letter queue captures failed events for retry without data loss

### Graceful Shutdown (GOOD)

- All three apps implement signal handlers (SIGTERM, SIGINT)
- 10-second force-exit timeout prevents hanging
- `app.close()` called before exit for cleanup
- `OnModuleDestroy` implemented by timer-owning services

---

## Recommendations Summary

| Priority | Action | Effort |
|----------|--------|--------|
| **HIGH** | Add `helmet` middleware to all 3 apps | Low — 3 lines per app |
| **HIGH** | Add global `ValidationPipe` + DTOs for ops endpoints | Medium — DTOs for each controller |
| **MEDIUM** | Restrict health endpoint detail for unauthenticated callers | Low — 5 lines |
| **MEDIUM** | Hash/mask PSIDs in logs and dead-letter entries | Low — utility function |
| **MEDIUM** | Ensure `/metrics` is consistently guarded | Low — verify each app |
| **LOW** | Cap `HTTP_JSON_BODY_LIMIT` at 1MB | Low — 3 lines |
| **INFO** | Add HSTS header when HTTPS is enforced | Low — helmet or manual header |

---

## Methodology

1. **Static analysis**: Grep/glob patterns for security-sensitive code across all `.ts` files
2. **Manual review**: Read key security-critical files in full (guards, crypto utils, repositories, controllers)
3. **Pattern matching**: Searched for hardcoded secrets, raw SQL, exec calls, missing auth, PII logging
4. **Cross-referencing**: Verified findings against AGENTS.md security section and docs

## Scope Limitations

- No dynamic testing (penetration testing) was performed
- No npm audit / dependency vulnerability scan was run
- No review of infrastructure/deployment configs (Dockerfile, nginx, CI/CD)
- TypeScript strict mode configuration not checked
- No review of test files for leaked secrets in fixtures

---

*Report generated by security audit agent. For questions, refer to the findings table above.*
