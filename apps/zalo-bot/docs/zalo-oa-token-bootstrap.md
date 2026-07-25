# Zalo OA token bootstrap (one-time, manual)

`zalo_oa_tokens` (see migration `1751029200004-CreateZaloOaTokensTable` in
`apps/messenger-bot`) starts empty — `ZaloTokenService.getValidAccessToken()`
throws `zalo_oa_tokens is empty` until the first `access_token`/`refresh_token`
pair is seeded manually. After that, `ZaloTokenRefreshService`'s cron
(every 45 min) keeps the pair fresh automatically — this is **not** something
that runs in CI/CD or on container start, only a one-time step done by
whoever manages the Official Account, right after the app is registered on
[developers.zalo.me](https://developers.zalo.me/).

This mirrors `apps/discord-bot/docs/discord-account-linking.md`'s "what a
human does once outside the app" style — see that file for the account-linking
counterpart (`zalo_account_links`, which *is* fully automated via
`ZaloOauthController`).

## Prerequisites

- A Zalo app registered at developers.zalo.me, with the **Official Account
  API** product added and linked to the OA you manage.
- `ZALO_APP_ID` / `ZALO_APP_SECRET_KEY` from that app's settings, already set
  in `apps/zalo-bot/.env` (see `.env.example`).
- A redirect URI registered on the app's OAuth settings (can reuse
  `ZALO_OAUTH_REDIRECT_URI`, or register a second one dedicated to this
  bootstrap — either works, it's only used once here).
- Access to the Postgres DB (`ai_chat_bot_db`) that `apps/zalo-bot` connects to.

## Steps

### 1. Get an authorization code (as the OA admin)

Open this URL in a browser while logged in as the account that administers
the OA, replacing `{ZALO_APP_ID}` and `{REDIRECT_URI}`:

```
https://oauth.zaloapp.com/v4/permission?app_id={ZALO_APP_ID}&redirect_uri={REDIRECT_URI}
```

Log in and approve the permission prompt. Zalo redirects to
`{REDIRECT_URI}?code=...` — copy the `code` query param (it's short-lived,
use it within a few minutes).

### 2. Exchange the code for the first token pair

```bash
curl -X POST \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "secret_key: <ZALO_APP_SECRET_KEY>" \
  --data-urlencode "code=<code from step 1>" \
  --data-urlencode "app_id=<ZALO_APP_ID>" \
  --data-urlencode "grant_type=authorization_code" \
  https://oauth.zaloapp.com/v4/access_token
```

Response:

```json
{
  "access_token": "...",
  "refresh_token": "...",
  "expires_in": "3600",
  "refresh_token_expires_in": "2592000"
}
```

If the app has PKCE enforced on this endpoint, generate a throwaway
`code_verifier`/`code_challenge` pair for this one-time call the same way
`ZaloAccountLinkService.buildPkcePair()` does (`code_challenge =
base64url(sha256(code_verifier))`), add `code_challenge` to the step 1 URL,
and add `code_verifier` to the step 2 body — this bootstrap call is unrelated
to end-user Zalo Login, so any verifier value works as long as both steps use
the same one.

### 3. Seed `zalo_oa_tokens`

Insert the pair directly (this table has no seed migration — only this
manual step populates it):

```sql
INSERT INTO zalo_oa_tokens
  (access_token, refresh_token, access_token_expires_at, refresh_token_expires_at, updated_at)
VALUES
  (
    '<access_token from step 2>',
    '<refresh_token from step 2>',
    now() + interval '3600 seconds',   -- from expires_in
    now() + interval '2592000 seconds', -- from refresh_token_expires_in
    now()
  );
```

Use the exact `expires_in`/`refresh_token_expires_in` values from the step 2
response instead of the literals above if they differ.

### 4. Verify

Restart (or start) `apps/zalo-bot`, then confirm the token is usable:

- `GET /health` returns `{ "status": "ok" }` (app booted, DB reachable).
- Trigger any outbound send (e.g. follow the OA from a test Zalo account) and
  confirm `ZaloOutboundService` doesn't log a `Zalo send message failed`
  warning.
- Watch logs for `ZaloTokenService: Zalo OA access_token refreshed` roughly
  every 45 minutes — confirms `ZaloTokenRefreshService`'s cron is keeping the
  pair alive without further manual steps.

## When you'd need to redo this

`refresh_token` is valid for 30 days and the cron refreshes proactively every
45 minutes, so under normal operation this bootstrap never repeats. Redo it
only if the app was down long enough that `refresh_token_expires_at` passed
(e.g. >30 days of downtime) — `ZaloTokenService.refresh()` will start failing
with `Zalo OA token refresh failed: HTTP ...` in that case, since Zalo's
refresh_token grant will reject an expired refresh_token and there is no
automatic recovery path (see spec §5.1).
