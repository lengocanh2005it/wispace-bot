# Reschedule button admission precedes the calendar write

Accepted while fixing [#1494](https://github.com/lengocanh2005it/wispace-bot/issues/1494). Discord's reschedule confirmation edit was the only learner-facing outbound delivery with no `OutboundRateLimiter` admission: every other path calls `DiscordOutboundService.admitOutbound`, and this one edited the interaction directly, then recorded `deliveryOutcome = 'sent'` unconditionally. Admission now runs **before** `confirm()` / `cancel()`, not at the edit as the issue proposed.

Gating the edit instead would admit a turn whose calendar write has already committed. Denying that turn produces a real change with no honest outcome to report, which is exactly the `attempting` state [#1418](https://github.com/lengocanh2005it/wispace-bot/issues/1418) and [#1483](https://github.com/lengocanh2005it/wispace-bot/issues/1483) established must never be replayed or misreported. Pre-mutation admission means a denial writes nothing, produces no attempt record, and leaves the staged row untouched — so the learner is told plainly that the schedule is unchanged and the request was discarded, rather than being left waiting on a button that resolves to nothing.

## Consequences

The limiter measures **outbound API calls toward one learner**, not messages, so an interaction edit is charged like any other call. A reschedule now costs two units — the proposal message carrying the buttons, plus the confirmation edit. With the default cap of 30 per 10 minutes, visible reschedules per learner drop from 30 to 15 per window. This is a deliberate behaviour change, not a regression.

The refusal edit is exempt and charges nothing. It is the limiter's own answer, so charging it would deny the learner the explanation of their own denial.

`DiscordOutboundService.admitOutbound` is public so the gateway can take the same decision for a delivery that does not route through that service. The gateway never re-derives the bucket identity or the decision metric itself, and the edit-failure fallback `sendText` passes the same `userId` so one turn cannot draw from two buckets.

The identity lookup moved ahead of admission and stayed inside the existing error boundary, so a lookup failure degrades to the generic failure message instead of rejecting the handler and leaving the learner on a spinner.

Menu replies and chat replies remain ungated: pressing a menu mutates nothing, so gating those is a separate learner-visible UX decision. Interaction edits are not blanket-covered by this ADR.

The issue's claim that a `rate_limited` outcome lets the recovery cron retry is false on Discord — the cron has no notification transport wired there. That gap, and a platform-scoping bug in the cron's query, are tracked in [#1507](https://github.com/lengocanh2005it/wispace-bot/issues/1507).