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

`GET /v1/discord/oauth/callback?code=...&state=...` (`DiscordOauthController`):
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
   Discord, `zaloId` for Zalo), `platform` says which one calling.
   Messenger's `WispaceMessengerTokenVerifyService` sends the same shape
   (`{ token, value, platform: 'messenger' }`) to the same URL.

   Expected response: `{ "userId": 143 }` on success, or
   `{ "valid": false, "reason": "NOT_FOUND" | "EXPIRED" | "USED" | "INVALID_FORMAT" }`
   on failure (mirrors the Messenger verify endpoint's failure reasons).
3. **Commit the mapping immediately** — upsert `(platform='discord',
   external_user_id=discordUserId, user_id)` into `discord_account_links`
   (1:1 both directions — matches Messenger's L4 mapping uniqueness) **right
   after verify, independent of guild membership** (retried 3× because the
   verify already consumed the single-use token). This keeps WISPACE's
   "Đã liên kết" state (which it marks at verify time) exactly in sync with
   the bot's mapping — no pending state, no join required to be linked.
4. Redirect the browser: if the user is already in the guild → send the
   welcome DM (Vietnamese quick-action menu buttons) and redirect to
   `DISCORD_LINK_LANDING_URL`; otherwise redirect straight to
   `DISCORD_INVITE_URL` — the welcome DM is delivered when `guildMemberAdd`
   fires (`DiscordChatGateway` re-sends it for already-linked users).
   The redirect URLs never carry secrets and the frontend needs no callback
   page (the portal shows the link state itself).

> **Why no "join-before-link"?** Discord DMs need a shared guild, but the
> *mapping* does not. Linking commits at callback so a user who never joins
> is still correctly linked (they just don't receive bot messages until they
> join). See `docs/project-overview.md` §13 and `docs/wispace-integration-guide.md`
> Part 6 for the contract.

## Link status for the portal UI

`GET /v1/discord/link-status?userId={wispaceUserId}` (guarded by
`InternalApiKeyGuard` — header `X-Internal-Api-Key`) returns
`{ linked, inGuild }` so the portal can show the join hint only when the
user is linked but not in the guild. See
`DiscordLinkStatusController` (`discord-link-status.controller.ts`) and
`docs/wispace-integration-guide.md` Part 6 for the full contract.

## Remaining follow-up

All seven real WISPACE tool handlers call the real Wispace API when
`ctx.userId` is resolved: goals, progress, upcoming sessions, calendar
entries, reminder preview, rescheduling, and `precreate_next_exercise` (next
roadmap exercise creation). The remaining `register_exam_report_notifications`
handler is intentionally unnecessary for Discord because Discord has no
Messenger-style 24-hour messaging limit; the 08:00 report cron sends reports
to linked accounts instead.
