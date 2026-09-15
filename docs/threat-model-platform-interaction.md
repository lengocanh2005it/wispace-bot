# Threat model — platform interaction

**Date:** 2026-09-15 · **Branch:** `main` · **Scope:** boundaries B1 and B4 — everything between a messaging platform (Meta, Discord, Zalo) and this system, in both directions.

Closes the remaining named gap on #693: "platform interaction and privileged operations without a model". Privileged operations turned out to be covered — Flow 5 of [`threat-model-wispace-data-and-outbound.md`](./threat-model-wispace-data-and-outbound.md) models the ops surface and its residual R7. This document takes the half that is genuinely unmodelled.

The two existing models treat the platform boundary as a precondition: #915's model starts _after_ an identity is verified, and #729's covers the account-link protocol. Neither asks what the platform itself is trusted for, or what happens when that trust is misplaced.

## What the platform is trusted for

Each platform is trusted for exactly three things, and it is worth writing them down because every threat below is a case of one of them being wrong:

1. **Authenticity of inbound events** — that an event attributed to platform user `X` was really sent by the person controlling account `X`.
2. **Stability of the identifier** — that `X` means the same person tomorrow as today.
3. **Correct delivery** — that a message addressed to `X` reaches only `X`.

The system has no independent way to check any of the three. There is no learner credential, no second factor, and no out-of-band confirmation. A platform identity _is_ the learner as far as this system can tell.

## Principals

- **Learner** — a platform account holder, possibly linked to a WISPACE user.
- **Non-learner** — any platform account that can reach the bot: a Discord server member, someone who messages the Page, an OA follower. Unlinked, but able to consume the bot.
- **Platform** — Meta, Discord, or Zalo. Delivers inbound, accepts outbound, owns identifiers and addressing.
- **Bot process** — holds the platform credentials (page access token, Discord bot token, Zalo OA token).

## Trust boundaries in scope

```
B1  platform -> bot      inbound events
B4  bot -> platform      outbound sends
```

B1 has three distinct shapes, and their trust properties are not the same:

| Platform  | Transport                       | Authenticity control                                                             | Freshness control                             |
| --------- | ------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------- |
| Messenger | HTTPS webhook                   | HMAC-SHA256 over the raw body, constant-time compare                             | `X-Hub-Timestamp`, ±5 min (#350)              |
| Zalo      | HTTPS webhook                   | SHA-256 over `appId + rawBody + timestamp + appSecretKey`, constant-time compare | timestamp inside the MAC, ±5 min              |
| Discord   | Authenticated WebSocket gateway | TLS plus the bot token — **no per-event signature exists to verify**             | none; ordering and delivery are the gateway's |

Discord is structurally different and the model should say so rather than treat all three as equivalent: there is no per-message artefact to verify, so the trust is entirely in the session. That is the correct design for a gateway, but it means a compromised bot token is not only an outbound problem — it is inbound authenticity as well.

## Threat table

| #   | Threat                                                                                           | STRIDE | Control today                                                                                                                                                                                     | Disposition                                                                                        |
| --- | ------------------------------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| P1  | Forged webhook delivers an event as another learner                                              | S      | HMAC / SHA-256 signature, constant-time, fail-closed guard                                                                                                                                        | Covered                                                                                            |
| P2  | Captured webhook replayed later                                                                  | T      | Timestamp freshness ±5 min on both webhook platforms, plus `(platform, event_id)` dedupe in `webhook_inbound_events`                                                                              | Covered; #350 chose the timestamp precisely because dedupe retention expires                       |
| P3  | The bot's own outbound is echoed back and processed as learner input                             | S      | `is_echo` filtered in the Messenger router; `message.author.bot` filtered in the Discord gateway                                                                                                  | Covered. Zalo relies on event-type routing — worth an explicit assertion                           |
| P4  | Non-learner drives the bot (quota, cost, probing)                                                | D      | Per-user daily quota and burst counter; Discord server channels require an @mention                                                                                                               | **Residual P-R1** — quota is per platform account, so cost scales with accounts, not with learners |
| P5  | Private learner data posted into a public Discord channel                                        | I      | Chat answers always leave through `DiscordOutboundService`, which resolves the user's DM channel; only canned replies (greeting, self-intro, non-disclosure, fallback) use `message.reply` inline | Covered by construction — see the note below                                                       |
| P6  | Learner's platform account is taken over; attacker inherits the WISPACE link                     | S      | none — a link, once made, is never re-verified against a fresh authentication                                                                                                                     | **Residual P-R2**, unowned                                                                         |
| P7  | Platform reuses an identifier for a different person                                             | S      | Mapping-generation fence on reminders (#999), but only when reuse produces a new generation                                                                                                       | #1124                                                                                              |
| P8  | Bot token or page token compromised — read every inbound event, send as the bot to every learner | S/I    | Vault-sourced secrets; Zalo OA token encrypted at rest                                                                                                                                            | **Residual P-R3** — no revocation runbook, no detection                                            |
| P9  | Message delivered to the wrong recipient after a relink                                          | I      | Reminder dispatch re-resolves the owner at claim time and fails closed                                                                                                                            | Covered (#999); the report retry path is not (#1000)                                               |
| P10 | Learner leaves the OA or blocks the bot and sends keep running                                   | I      | Zalo `unfollow` is log-only                                                                                                                                                                       | #1021                                                                                              |
| P11 | Bot cannot deliver at all (DMs closed, Meta 24h window, Zalo OA window)                          | D      | Dead-letter plus retry; the Discord case surfaces as silence                                                                                                                                      | #786, #728                                                                                         |
| P12 | Platform-supplied profile text (display name) treated as instructions                            | T      | `sanitizeUntrustedTextForLlm` at the Messenger suffix; Discord and Zalo never put the name in the prompt                                                                                          | Covered                                                                                            |

### Note on P5

This is worth recording as a _property_, not a passing observation, because it is easy to lose. `DiscordOutboundService` sends by resolving the DM channel from the user id rather than replying on the gateway event. That choice was made so proactive sends could reuse the path — a reason unrelated to privacy — and the privacy property is a side effect of it.

Anything that later "fixes" server-channel replies to answer inline would silently publish a learner's target band, exam date, and calendar into a public channel. If that refactor is ever proposed, this paragraph is the reason to stop it.

## Residual risks

| #    | Risk                                                                                                                                        | Why it is not covered                                                      | Proposed disposition                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| P-R1 | Cost and quota scale per platform account, not per human. A non-learner, or a pool of accounts, can consume LLM budget without ever linking | Quota is deliberately keyed `(platform, external_user_id)`                 | Accept, and let the fleet cost ceiling (#890, #911) be the real bound. The acceptance needs recording                                  |
| P-R2 | A linked account, once verified, is never re-verified. Platform account takeover inherits the WISPACE link indefinitely                     | `last_verified_at` exists on every mapping row but nothing acts on its age | Needs a decision: a maximum link age, or an explicit written acceptance that platform account security is the learner's responsibility |
| P-R3 | Platform credential compromise has no detection and no rehearsed revocation                                                                 | Out of scope of the host model, which stops at the host                    | Folds into #1199 (detection); the revocation half needs a runbook line                                                                 |

## Related

- #693 — audit coverage map; this closes the "platform interaction" line
- #915, #729 — the two models this one sits beside
- #350 — webhook replay protection, the reason P2 is covered
- #999, #1000, #1124 — the identity fence and its gaps
- #786, #1021, #728 — delivery-side platform policy
- #1199 — host and credential detection, which P-R3 depends on
