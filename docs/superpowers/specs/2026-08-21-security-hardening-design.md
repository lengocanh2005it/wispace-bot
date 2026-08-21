# Design: Security Hardening — #277 + #262 + #264 + #281

## Scope

| Issue | Title | Status |
|-------|-------|--------|
| #277 | Remove public PostgreSQL port exposure | In scope — explicit localhost bindings |
| #262 | Drop raw message_text from message_logs | In scope — Phase 2 migration |
| #264 | Bind Discord OAuth link state to browser session | In scope — random state binding |
| #281 | Restrict deploy account Docker/Nginx privileges | In scope — reject uid 0, document |

## #277: Explicit localhost bindings for PostgreSQL

### Problem

PostgreSQL ports may be exposed to `0.0.0.0` via Docker port publishing. Even if current config is localhost-bound, explicit bindings prevent future accidents.

### Fix

Add explicit `127.0.0.1:` prefix to any PostgreSQL port mapping in docker-compose files. If no docker-compose files expose DB ports (confirmed: they don't), add a comment-only guard or CI check to the deploy docs.

### Files changed

- `deploy/monitoring/docker-compose.yml` — add `127.0.0.1:` to postgres port if present
- `docs/project-overview.md` — add note about DB port exposure policy

## #262: Drop message_text column from Messenger's message_logs

### Problem

Migration `1786915000000` nulls existing data but keeps the nullable column. The entity and application code already don't use it, but the column remains in schema.

### Fix

Add a Phase 2 migration to DROP `message_text` from `message_logs`. The column is already nullable and never written to.

### Files changed

- `packages/database/src/migrations/20260821000001-DropMessageLogsMessageTextColumn.ts` — **new** migration

## #264: Discord OAuth CSRF state binding

### Problem

Discord OAuth accepts the WISPACE link token directly as `state` — no CSRF nonce. An attacker who obtains their own link token can trick a victim into completing the flow, linking the attacker's Discord to the victim's WISPACE account.

### Fix

Mirror Zalo's approach:
1. Generate `randomBytes(24)` state when creating the OAuth URL.
2. Store state → {linkToken, discordUserId} server-side with TTL.
3. On callback, consume state, retrieve linkToken, proceed.

**Option: new table vs reuse existing verify records.** The `discord_link_verify_records` table is for crash recovery after WISPACE verification — different lifecycle. Create a dedicated `discord_oauth_states` table (same pattern as `zalo_oauth_states`).

### Files changed

- `packages/database/src/entities/discord-oauth-state.entity.ts` — **new** entity
- `packages/database/src/migrations/YYYYMMDD-HHMMSS-CreateDiscordOauthStatesTable.ts` — **new** migration
- `apps/discord-bot/src/modules/account-link/application/services/discord-oauth-state.service.ts` — **new** service
- `apps/discord-bot/src/modules/account-link/presentation/controllers/discord-oauth.controller.ts` — use state binding
- `apps/discord-bot/src/modules/account-link/discord-account-link.module.ts` — register new service/entity

## #281: Reject uid 0 in deploy script

### Problem

`DEPLOY_UID`/`DEPLOY_GID` can be set to 0, running containers as root.

### Fix

Add a guard in `vps-deploy.sh` that fails if `DEPLOY_UID` is 0. Document that sudoers should restrict nginx reload to the deploy user only.

### Files changed

- `.github/scripts/vps-deploy.sh` — add uid 0 guard
