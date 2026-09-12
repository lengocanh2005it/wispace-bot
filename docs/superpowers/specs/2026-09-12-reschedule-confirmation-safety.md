# Issue #1037 — Token-bound staged reschedule cancellation and confirmation safety

Status: agreed during domain modeling

## Problem Statement

From the learner's perspective, the bot says that a stop request was accepted while a staged reschedule remains armed for up to ten minutes. On Zalo, a bare `ok` can then confirm that unrelated reschedule later, causing an irreversible calendar write even though the learner did not explicitly approve the proposal. The current Zalo prompt also says to reply with `xác nhận` while the durable production store already carries a one-time approval token.

## Solution

Make the staged reschedule lifecycle explicit and token-bound across Messenger, Discord, and Zalo.

- A stop request clears both clarification state and the learner's staged reschedule for the current platform identity when it is still pending.
- A calendar write is authorized only by a platform button carrying the current token, the exact token, `xác nhận <token>`, or `đồng ý <token>`. Bare `ok`, `yes`, `confirm`, `xác nhận`, and `đồng ý` never authorize a write.
- A token-less, invalid, mismatched, expired, or superseded confirmation is rejected without calling the calendar write.
- Expiry is reported on the next related reschedule interaction. No background expiry notification is added.
- A failed or ambiguous delivery of the proposal removes the staged request because the learner could not reliably have seen its token.

## User Stories

1. As a learner, I want `thôi`, `dừng`, `hủy`, or another recognized stop request to remove my pending reschedule, so that the bot's acknowledgement matches the actual state.
2. As a learner, I want a stop request to clear an active clarification menu and a staged reschedule together, so that no abandoned action remains armed behind the acknowledgement.
3. As a learner, I want a stop acknowledgement without a reschedule-specific claim when no staged reschedule exists, so that the bot does not claim to cancel something that was not pending.
4. As a learner, I want an explicit reschedule cancel command or platform cancel button to leave my calendar unchanged, so that cancellation is safe and predictable.
5. As a learner, I want a bare `ok` while a proposal is pending to do nothing to my calendar, so that an acknowledgement of an unrelated message cannot approve a schedule change.
6. As a learner, I want bare `yes`, `confirm`, `xác nhận`, and `đồng ý` to be treated as insufficient approval, so that filler or ambiguous words cannot authorize an irreversible action.
7. As a learner, I want to confirm with `xác nhận <token>`, so that the confirmation is visibly tied to the proposal I was shown.
8. As a learner, I want to confirm with `đồng ý <token>`, so that the Vietnamese affirmative form is explicit without weakening token binding.
9. As a learner, I want to submit the exact approval token by itself when necessary, so that the one-time token remains a usable approval mechanism.
10. As a learner, I want a wrong, malformed, old, or superseded token to be rejected without a calendar call, so that only the current proposal can be committed.
11. As a learner, I want a confirmation without the offered token to be rejected, so that the system does not infer that I saw a proposal I may never have received.
12. As a learner, I want an expired proposal to be reported as expired on my next related interaction, so that silence never leaves me guessing whether it is still armed.
13. As a learner, I want an expired proposal never to be renewed by a late confirmation, so that waiting cannot extend authorization.
14. As a learner, I want unrelated chat to continue normally while a valid staged reschedule remains pending, so that the proposal does not hijack every conversation.
15. As a learner, I want a new reschedule request to replace the previous proposal for the same platform identity, so that there is only one current calendar change to approve.
16. As a learner, I want the old token to stop working after a new proposal replaces it, so that an earlier intention cannot commit a later schedule.
17. As a learner, I want a failed proposal delivery not to leave a hidden action armed, so that a message I did not receive cannot later change my calendar.
18. As a learner, I want a stop that races with confirmation to be handled deterministically, so that either the pending request is canceled or the bot honestly tells me that the write has already started.
19. As a learner, I want a Zalo proposal to show the exact tokenized reply syntax, so that I know how to confirm without guessing.
20. As a learner, I want Messenger and Discord buttons to remain the normal confirmation path, so that their existing interaction model does not regress.
21. As a learner, I want a stop on Zalo to affect only my Zalo proposal, so that actions on one platform do not unexpectedly cancel another platform's proposal.
22. As a learner, I want invalid confirmation feedback to be deterministic and platform-appropriate, so that a model-generated answer cannot accidentally imply that a write happened.
23. As a platform adapter owner, I want text parsing to remain platform-specific while the shared confirmation service remains authoritative, so that platform UX can vary without duplicating security checks.
24. As a platform adapter owner, I want the shared chat agent to call one framework-agnostic cancellation seam, so that every stop path uses the same cleanup behavior.
25. As a maintainer, I want the existing user, platform, mapping, intent, argument, and one-time-token bindings to remain enforced, so that this fix does not weaken identity or intent protection.
26. As a maintainer, I want no new expiry cron, read-receipt system, or database status migration, so that the fix stays small and failure-safe.
27. As a maintainer, I want tests at the shared state/confirmation seam plus thin platform routing seams, so that the same invariant is proven once and platform regressions remain visible.

## Implementation Decisions

- The canonical domain term is **staged reschedule**: a validated request awaiting approval that has not mutated the calendar.
- There is at most one active staged reschedule per platform-scoped external identity. A newer proposal supersedes the previous proposal and invalidates its token.
- The durable approval token is the binding between the learner's explicit approval and the exact staged proposal. Production confirmation continues to verify the current learner, platform, mapping revision, intent/argument binding, and token.
- `PlatformAgentService` receives one optional framework-agnostic cancellation capability. Both stop branches—while clarification state exists and when it does not—invoke it for the current `externalUserId`.
- The cancellation capability reports whether a pending proposal was removed, no proposal existed, or the proposal was already being processed. The shared agent and platform adapters render deterministic messages from that outcome.
- A stop/cancel can remove only a pending staged reschedule. Once confirmation has atomically claimed the proposal for the calendar write, cancellation cannot undo it.
- Zalo owns the text command parser. It accepts only normalized `xác nhận <token>`, `đồng ý <token>`, or the exact token. It rejects bare affirmative words, `Mã:` prefixes, and trailing prose. Messenger and Discord keep button payload parsing in their platform adapters.
- The shared `RescheduleConfirmationService` remains the final authority for token shape, proposal binding, expiry, claim, and calendar-write authorization. Platform parsers cannot bypass it.
- When a valid staged proposal exists, a bare `ok` is consumed by the Zalo reschedule guard, returns deterministic guidance, does not enter the LLM pipeline, and leaves the proposal pending. With no proposal, `ok` follows the normal chat path.
- Expiry is lazy. The next related reschedule interaction receives an explicit expired outcome and the expired proposal is removed; expiry does not renew authorization and does not add a background outbound job or new database status.
- If proposal delivery fails or returns an ambiguous delivery result, the staged proposal is removed. The learner must issue a new reschedule request.
- Privacy/consent commands are evaluated by their existing platform-specific handlers before free-form stop handling. A phrase such as `hủy báo cáo` is not reinterpreted as a reschedule stop; an exact stop request is.
- All outcomes are platform-scoped. A stop or confirmation on one platform never affects another platform's staged proposal for the same WISPACE `userId`.
- The behavior is always on. No compatibility flag or temporary acceptance of token-less confirmations is added.
- No schema migration is required for the expiry or confirmation policy.

## Testing Decisions

- Tests assert external behavior and side effects, not private implementation details. A test passes only when it proves the calendar write was or was not invoked, the staged state changed as specified, and the learner-facing outcome is correct.
- The highest shared seam is the reschedule confirmation/state machine plus the shared platform-agent cancellation capability. This is the primary contract test surface.
- Thin platform tests cover only routing and presentation: Zalo command recognition, Zalo tokenized prompt syntax, Messenger button payloads, and Discord button payloads.
- Existing reschedule confirmation service tests are extended for exact token forms, bare-word rejection, malformed/wrong/old/superseded tokens, expiry, replacement, delivery failure cleanup, and claim-vs-stop races.
- Existing platform-agent tests are extended for stop with and without clarification state, stop with and without a staged reschedule, processing-state honesty, and false-positive protection for stop words inside longer messages.
- Existing Zalo chat service tests are extended for `ok` at nine minutes, explicit token confirmation, token-less rejection, expired confirmation, no-pending fallback to normal chat, and no accidental enqueue for a pending bare `ok`.
- Messenger and Discord gateway tests verify that button actions carry the current token and that the wrong/old token never reaches the calendar port.
- Cross-platform tests prove that a proposal and stop are isolated by platform-scoped external identity.
- The regression matrix includes: stop → pending gone; `ok` nine minutes later → no calendar call and proposal remains; explicit valid confirm → reschedule proceeds; expiry → explicit expired outcome; new proposal → old token rejected; proposal delivery failure → pending gone.

## Out of Scope

- Reversing or compensating for a calendar write that has already started.
- Read receipts, message-seen tracking, or a separate proposal/message identifier.
- A background expiry cron, proactive expiry notification, or a new expiry outbox.
- A new `expired` database status or migration.
- Multiple simultaneous proposals for one platform-scoped external identity.
- Cross-platform cancellation or confirmation.
- Changes to study reminder jobs, privacy consent state, account linking, or unrelated chat semantics.
- LLM-based interpretation of confirmation commands.
- A feature flag or a temporary legacy path that accepts token-less confirmation.
- New end-to-end infrastructure beyond the existing shared and platform adapter test seams.

## Further Notes

- The user-facing term for the opaque approval token is **mã xác nhận**; the domain glossary uses **approval token**.
- The Zalo prompt must teach the exact tokenized command rather than saying only `xác nhận`.
- The accepted rationale is recorded in ADR-0011 and the vocabulary/invariants are recorded in the root domain glossary.
- This spec is a synthesis of the existing issue, repository behavior, and the completed domain-modeling grill; implementation has not started.
