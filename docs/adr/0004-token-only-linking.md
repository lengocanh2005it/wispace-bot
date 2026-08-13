# Token-only linking (L4) instead of ref-only

Messenger-to-WISPACE account linking uses token-based verification: the user opens an `m.me` link with a token, and the bot calls `WISPACE_API_VERIFY_TOKEN_URL` to verify `{token, value, platform}`. This prevents relinking a PSID already linked to a different userId (L4 constraint). Discord uses OAuth2 and Zalo uses OAuth2 with PKCE to obtain their platform identities, then both pass the WISPACE link token to the same verification API.

## Rationale

- **Security**: Token verification ensures the user actually controls the WISPACE account. Ref-only allows anyone with the `m.me` link to link without ownership verification.
- **1:1 Messenger mapping**: Each Messenger PSID links to only 1 userId, and each userId links to only 1 Messenger PSID. Prevents abuse (multiple accounts sharing one bot, or one account linking to multiple bots).
- **Prevents relink (L4, Messenger)**: Once linked, a Messenger PSID cannot link to a different userId without ops intervention (`allowRelink`). Prevents scenarios where a user switches accounts.
- **Shared verification contract**: The same WISPACE token-verification API is reused by Messenger, Discord, and Zalo; Messenger carries the token in `m.me` `ref`, while Discord/Zalo carry it through their OAuth flow. Ref-only is only suitable for Messenger.

## Alternatives considered

| Alternative | Reason for rejection |
|-------------|---------------------|
| Ref-only linking (legacy) | Does not verify ownership. Anyone with the link `m.me?ref=X` could link another user's account. |
| Full OAuth2 flow | Rejected for Messenger at this stage: it requires redirect URI and consent handling. Discord and Zalo use their platform OAuth flows because their platform identity is obtained through OAuth. |
| Magic link (email) | Requires email infrastructure. Longer user journey. |

## Consequences

- Messenger users must click the `m.me` link from within the WISPACE app (the link cannot be shared with others). Discord/Zalo users complete the platform OAuth authorization/callback flow.
- For Messenger, linking to a different account requires ops intervention (`POST /messenger/mapping/relink`). Discord/Zalo OAuth linking can replace an existing platform link through their account-link services.
- When multi-device support is needed (the same WISPACE account on multiple Messenger accounts), the Messenger L4 constraint will need to be reconsidered.
- WISPACE owns the link-token lifecycle. The bots treat the WISPACE verification response as authoritative and do not create or rotate link tokens locally; platform OAuth credentials are managed by their respective OAuth modules.
