# WISPACE Bot Integration Guide — For WISPACE Team

This document describes what the WISPACE team needs to do to integrate with the **Discord Bot** system (and align with the existing Messenger Bot).

---

## Overview

| Bot | Status | Account linking method |
|-----|--------|----------------------|
| Messenger Bot | Running in production | `m.me/<page>?ref=<token>` |
| Discord Bot | Running in production | Discord OAuth2 + link token |
| Zalo Bot | Running in production | Zalo OA OAuth2 + link token |

All 3 bots use **the same API endpoint** to verify link tokens — the WISPACE team only needs to implement it once.

---

## Part 1 — Token verification API (shared for Messenger & Discord)

### Endpoint

```
POST {WISPACE_API_VERIFY_TOKEN_URL}
```

The specific URL is provided by the WISPACE team and stored in the environment variable `WISPACE_API_VERIFY_TOKEN_URL` on the bot side.

### Headers

```
Content-Type: application/json
X-Internal-Key: {WISPACE_INTERNAL_KEY}
```

`WISPACE_INTERNAL_KEY` is a shared secret between WISPACE backend and the bots — it does not change per platform.

### Request body

```json
{
  "token": "<link_token>",
  "value": "<platform_user_id>",
  "platform": "messenger" | "discord" | "zalo"
}
```

| Field | Description |
|-------|-------------|
| `token` | Link token created by WISPACE and sent to the user |
| `value` | Platform-specific user ID: PSID (Messenger), Discord User ID (Discord), Zalo User ID (Zalo) |
| `platform` | Platform name — used by WISPACE to distinguish the calling source |

### Successful response (HTTP 200)

```json
{
  "userId": 143
}
```

`userId` is the student ID in the WISPACE system — the bot uses this to store the mapping `(platform, externalUserId) ↔ userId`.

> **Messenger note:** In addition to `userId`, the Messenger response currently returns `topic` and `cadence` for configuring study reports. Discord and Zalo use their own report configuration/cron paths and do not depend on these Messenger-specific fields.

### Failure response (HTTP 4xx)

```json
{
  "valid": false,
  "reason": "NOT_FOUND" | "EXPIRED" | "USED" | "INVALID_FORMAT"
}
```

| reason | Meaning |
|--------|---------|
| `NOT_FOUND` | Token does not exist |
| `EXPIRED` | Token has expired |
| `USED` | Token has already been used (single-use) |
| `INVALID_FORMAT` | Token is in the wrong format |

---

## Part 2 — Discord linking flow (WISPACE needs to do)

### Step 1 — Create a link token

Same mechanism as the current Messenger flow — WISPACE creates a short-lived link token (e.g., UUID, JWT, or any opaque string), stores it server-side with `userId` + expiry (recommended: 10–30 minutes, single-use).

### Step 2 — Display "Connect Discord" button in WISPACE app/web

Render a link (button or `<a href>`) pointing to the following URL:

```
https://discord.com/oauth2/authorize
  ?client_id={DISCORD_CLIENT_ID}
  &redirect_uri={DISCORD_OAUTH_REDIRECT_URI}
  &response_type=code
  &scope=identify
  &state={LINK_TOKEN}
```

Replace the values:

| Placeholder | Actual value | Notes |
|-------------|-------------|-------|
| `{DISCORD_CLIENT_ID}` | Discord Application ID | Get from the bot team |
| `{DISCORD_OAUTH_REDIRECT_URI}` | `https://<domain-bot>/v1/discord/oauth/callback` | Get from the bot team |
| `{LINK_TOKEN}` | Token created by WISPACE in Step 1 | **Pass as-is into `state`** |

> **Important:** `state` must be the original link token (no additional encoding). The bot will read `state` and send it directly to the WISPACE API for verification.

Example complete URL:

```
https://discord.com/oauth2/authorize?client_id=1521508932164522095&redirect_uri=https%3A%2F%2Fbot.wispace.vn%2Fdiscord%2Foauth%2Fcallback&response_type=code&scope=identify&state=abc123xyz
```

### Step 3 — Bot handles the rest automatically

After the user clicks "Allow" on the Discord page, the entire bot-side flow is automatic:

1. Discord redirects to `{DISCORD_OAUTH_REDIRECT_URI}?code=xxx&state={LINK_TOKEN}`
2. Bot exchanges `code` → Discord access token → retrieves `discordUserId`
3. Bot calls `POST {WISPACE_API_VERIFY_TOKEN_URL}` with `{ token, value: discordUserId, platform: "discord" }` — **verify success = link completed** (mapping is committed right after, independent of guild membership)
4. Bot stores mapping `discordUserId ↔ userId` in the DB
5. Bot sends a welcome message to the student's Discord DM (only possible if they share a server; otherwise the welcome is sent when they join — see Part 6)
6. Bot redirects the browser to the portal landing URL (success/failure), or straight to the Discord server invite if the user is not in the guild yet

**WISPACE does not need to do anything after Step 2.**

---

## Part 3 — Current Messenger flow (for reference)

Messenger uses `m.me` deep links to pass the token via the `ref` parameter:

```
https://m.me/{PAGE_ID}?ref={LINK_TOKEN}
```

When a user clicks, Facebook sends a `messaging_referrals` event (or `postback`) to the Messenger Bot webhook, with `ref = LINK_TOKEN`. The bot verifies with the same API endpoint above (`platform: "messenger"`).

**The only difference** from Discord: the token delivery mechanism (Messenger uses `ref`, Discord uses OAuth2 `state`) — the verification API and response format are identical.

---

## Part 4 — Information to provide to the bot team

For the bot to run in production, the WISPACE team needs to provide:

| Variable | Description |
|----------|-------------|
| `WISPACE_API_VERIFY_TOKEN_URL` | Token verification endpoint URL (shared for Messenger + Discord) |
| `WISPACE_INTERNAL_KEY` | Shared secret for authenticating requests from the bot |

And the bot team will provide to WISPACE:

| Information | Description |
|-------------|-------------|
| `DISCORD_CLIENT_ID` | Discord Application ID |
| `DISCORD_OAUTH_REDIRECT_URI` | Callback URL registered on the Discord Developer Portal |

---

## Part 5 — Student identification headers when chatting

After accounts are linked, whenever a student messages the bot, the bot will call the Wispace API with the corresponding platform-specific identification header:

| Platform | Header |
|----------|--------|
| Messenger | `x-psid: {PSID}` |
| Discord | `x-discordid: {Discord User ID}` |
| Zalo | `x-zaloid: {Zalo User ID}` |

Along with the common header:

```
X-Internal-Key: {WISPACE_INTERNAL_KEY}
```

The WISPACE API already supports all 3 headers — no changes needed on the WISPACE side.

---

## Part 6 — Discord server requirements

Discord has a technical limitation: **the bot can only send DMs to a user if they share at least one server** (welcome message, study reports, reminders). Joining the server is therefore needed to *receive* bot messages — but it is **not** required to complete the account link.

### Important contract note — when "linked" becomes official

The bot commits the mapping (`discordUserId ↔ userId`) **immediately at OAuth callback**, right after `verify-token` succeeds. WISPACE may mark the user as linked as soon as its verify endpoint returns (the link token is single-use anyway) — this now matches the bot exactly: **`verify-token` success = link completed**, regardless of guild membership. There is no intermediate pending state on the bot side.

### What WISPACE needs to do

1. Create an official Discord server (e.g. "WISPACE Community"), add the bot, and **recommend** (not require) students to join it before/after linking.
2. No callback page is needed on the frontend: after the OAuth callback the bot redirects the browser either to the portal landing URL (success/error/cancel) or straight to the Discord server invite (user not yet in the guild). The bot delivers the welcome DM on `guildMemberAdd` for users who join later.
3. Students who link but never join will show as "Đã liên kết" correctly — they simply won't receive bot messages until they join.

### Recommended UI hint (frontend copy, no code needed on the bot)

Show the hint **only** for linked users who are NOT in the guild — query the
bot's link-status endpoint first, then render:

| `link-status` result | UI |
|---|---|
| `{ linked: false }` | Nút "Kết nối Discord" (như cũ) |
| `{ linked: true, inGuild: true }` | "Đã liên kết ✓" — không hint |
| `{ linked: true, inGuild: false }` | "Đã liên kết ✓ — Tham gia server Discord [tại đây](https://discord.gg/xxx) để nhận báo cáo và nhắc nhở học tập." (link ẩn trỏ invite) |

### Link-status endpoint (contract)

```
GET {BOT_URL}/v1/discord/link-status?userId={wispaceUserId}
Headers: X-Internal-Api-Key: {INTERNAL_API_KEY}
```

| Response | Meaning |
|---|---|
| `{ "linked": false, "inGuild": false }` | No Discord mapping for this user |
| `{ "linked": true, "inGuild": true }` | Linked + already in the guild |
| `{ "linked": true, "inGuild": false }` | Linked + not in the guild (show the join hint) |
| HTTP 400 | `userId` missing or not a positive integer |

Bot team provides `INTERNAL_API_KEY` (same header used for ops endpoints).

### Additional information for the bot team

| Information | Description |
|-------------|-------------|
| Discord Server Invite URL | WISPACE server invite link (format `https://discord.gg/xxx`) used as the post-callback redirect target for users not in the guild |
| Portal landing URL | Portal root (e.g. `https://testfrontend.aihubproduction.com/`) used as the post-callback redirect target on success/error/cancel |

---

## Summary of tasks

| # | Task | Owner |
|---|------|-------|
| 1 | Implement API `POST /verify-token` accepting `{ token, value, platform }`, returning `{ userId }` or `{ valid: false, reason }` | **WISPACE** |
| 2 | Create link token when user wants to connect Discord, store server-side with userId + expiry | **WISPACE** |
| 3 | Render button/link with Discord OAuth2 URL, `state` = link token | **WISPACE** |
| 4 | Create official Discord server, add bot to server, recommend students join to receive bot messages | **WISPACE** |
| 5 | Provide `WISPACE_API_VERIFY_TOKEN_URL`, `WISPACE_INTERNAL_KEY`, Discord Server Invite URL to the bot team | **WISPACE** |
| 6 | Provide `DISCORD_CLIENT_ID` and `DISCORD_OAUTH_REDIRECT_URI` to WISPACE | **Bot team** |
| 7 | Entire OAuth2 callback flow, verification, DB storage, welcome DM | **Bot team (completed)** |

> If the token verification API (`/verify-token`) already exists for Messenger, supporting Discord only requires adding the `platform === "discord"` condition — no new endpoint needed.

> **Discord limitation note:** If the student has not joined a shared server with the bot, the bot cannot send the welcome DM (Discord limitation, not an error). The account is still successfully linked — the student can still message the bot normally after joining the server later.
