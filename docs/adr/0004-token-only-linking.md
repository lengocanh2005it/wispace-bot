# Token-only linking (L4) instead of ref-only

Account linking between Messenger and WISPACE uses token-based verification: user opens `m.me` link with token, bot calls `WISPACE_API_VERIFY_TOKEN_URL` to verify `{token, value, platform}`. Prevents relinking a PSID already linked to a different userId (L4 constraint).

## Rationale

- **Security**: Token verification ensures the user actually controls the WISPACE account. Ref-only allows anyone with the `m.me` link to link without ownership verification.
- **1:1 mapping**: Each PSID links to only 1 userId, each userId links to only 1 PSID per platform. Prevents abuse (multiple accounts sharing one bot, or one account linking to multiple bots).
- **Prevents relink (L4)**: Once linked, cannot link to a different userId without ops intervention (`allowRelink`). Prevents scenarios where a user switches accounts.
- **Cross-platform ready**: Token-based linking works for Messenger, Discord, and Zalo. Ref-only is only suitable for Messenger.

## Alternatives considered

| Alternative | Reason for rejection |
|-------------|---------------------|
| Ref-only linking (legacy) | Does not verify ownership. Anyone with the link `m.me?ref=X` could link another user's account. |
| Full OAuth2 flow | Too complex at this stage. Requires redirect URI, consent screen, refresh tokens. |
| Magic link (email) | Requires email infrastructure. Longer user journey. |

## Consequences

- User must click the `m.me` link from within the WISPACE app (cannot share the link with others).
- If the user wants to link to a different account, ops intervention is required (`POST /messenger/mapping/relink`).
- When multi-device support is needed (same WISPACE account on multiple Messenger accounts), the L4 constraint will need to be reconsidered.
- Token expiry and rotation are not yet implemented — currently tokens are single-use but have no expiry time limit.
