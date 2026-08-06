# Discord account-linking (OAuth2 + WISPACE verify-token API)

Messenger links accounts via `m.me/<page>?ref=<token>`, a Facebook-specific
deep link that passes a `ref` payload into the first webhook event. Discord
has no equivalent — a plain Discord link/invite can't carry arbitrary
payload data to the bot. Instead, linking uses Discord's OAuth2 `identify`
scope to learn the Discord user id, combined with **WISPACE's existing
account-link verify API** (same one used for Messenger, generalized with a
`platform` field) to resolve the WISPACE `userId` — no new signing scheme,
no extra WISPACE backend endpoint needed.

## What WISPACE's web/app must do

1. Generate a link token (same mechanism as the Messenger `m.me` token —
   WISPACE already owns this, including its expiry/one-time-use state).
2. Render a link (button, `<a href>`, etc.) pointing to:

   ```
   https://discord.com/api/oauth2/authorize
     ?client_id={DISCORD_CLIENT_ID}
     &redirect_uri={DISCORD_OAUTH_REDIRECT_URI}
     &response_type=code
     &scope=identify
     &state={WISPACE_LINK_TOKEN}
   ```

   - `DISCORD_CLIENT_ID` / `DISCORD_OAUTH_REDIRECT_URI` — same values as this
     app's `.env` (`apps/discord-bot/.env.example`). `client_id` is the
     Discord bot's own Application (Discord Developer Portal → OAuth2 tab)
     — no separate Discord app needed.
   - `state` = the WISPACE link token **verbatim** (opaque to us — WISPACE
     owns its expiry/usage tracking, same as the Messenger token).

## What this repo does after the user authorizes

`GET /discord/oauth/callback?code=...&state=...` (`DiscordOauthController`):
1. Exchange `code` for a Discord access token, then fetch the Discord user id
   via `GET /users/@me` (`DiscordAccountLinkService.exchangeCodeForDiscordUserId`).
2. Call WISPACE's **shared** account-link verify API
   (`WispaceTokenVerifyService` from `@wispace/wispace-client`, platform
   `'discord'`) — same `WISPACE_API_VERIFY_TOKEN_URL`
   endpoint used by all 3 bots (`WISPACE_API_VERIFY_TOKEN_URL`, no more
   per-platform URL — see root `.env.shared.example`):

   ```
   POST {WISPACE_API_VERIFY_TOKEN_URL}
   Headers: X-Internal-Key: {WISPACE_INTERNAL_KEY}
   Body: { "token": "<state>", "value": "<discordUserId>", "platform": "discord" }
   ```

   Unified payload shape shared by all 3 bots — `value` carries whatever the
   platform's external user id is (`psid` for Messenger, `discordId` for
   Discord, `zaloId` for Zalo later), `platform` says which one calling.
   Messenger's `WispaceMessengerTokenVerifyService` sends the same shape
   (`{ token, value, platform: 'messenger' }`) to the same URL.

   Expected response: `{ "userId": 143 }` on success, or
   `{ "valid": false, "reason": "NOT_FOUND" | "EXPIRED" | "USED" | "INVALID_FORMAT" }`
   on failure (mirrors the Messenger verify endpoint's failure reasons).
3. Upsert `(platform='discord', external_user_id=discordUserId, user_id)`
   into `discord_account_links` (1:1 both directions — matches Messenger's
   L4 mapping uniqueness).
4. Send a Vietnamese welcome DM to the student, and show a small HTML
   success page in the browser tab.

## Not yet done (follow-up)

The 7 WISPACE tools (`get_learning_progress_report`, `get_user_goals`, ...)
still return `available: false` for every Discord chat — `ctx.userId` is now
resolvable via `DiscordAccountLinkService.findUserIdByDiscordId`, but wiring
each tool to the real Wispace API endpoints is separate follow-up work.
