# Outbound Rate Limit (#622)

The three bots share one learner-facing rolling cap: **30 provider messages per 10 minutes**. A linked learner is keyed by the canonical WISPACE `userId`; before linking, the platform plus external id is used. The fallback bucket is intentionally not merged later.

## Configuration

Set these shared variables in Vault or the deployment environment:

```dotenv
OUTBOUND_RATE_LIMIT_ENABLED=true
OUTBOUND_RATE_LIMIT_MAX_MESSAGES=30
OUTBOUND_RATE_LIMIT_WINDOW_MS=600000
```

`MAX_MESSAGES` accepts 1-1000 and `WINDOW_MS` accepts 1000-86400000. Invalid values fail startup. Enabling the limiter in production requires a reachable Redis connection; disabling it does not.

## Behavior

The gate sits immediately before a learner-facing provider call. Chat, fallback/clarification, reminders, reports, templates, welcome/link/consent/reschedule messages, and dead-letter replay are covered. Typing/mark-seen signals and Discord server-channel messages are not covered.

One Discord path does not fit "immediately before delivery": the reschedule confirmation takes admission **before** the calendar write instead of before its edit (#1494), because that edit follows a mutation and denying it after the fact would leave a committed change with no honest outcome. The rest of the gate is delivery-adjacent; this one is mutation-adjacent.

Discord interaction edits are covered case by case, not blanket. Gated: the reschedule confirmation (#1494, the only interaction that follows a mutation) and both menu replies (#1508). Still exempt, with the reason recorded: `message.reply` in a server channel — the DM branch of every one of those handlers routes through `sendMenuButtons` or `sendText`, which are gated, so gating the server-channel branch as well would spend a learner's budget on a channel where their DM counterpart is still waiting.

Each provider attempt, retry, or message chunk consumes one unit. A multi-message send is admitted atomically; if the whole batch does not fit, no partial batch is sent. A denial is terminal for that delivery: chat refunds its inbound quota and completes the queue/inbox without fallback or retry; reminder/report/dead-letter paths record `outbound_rate_limited` and do not retry.

One reschedule interaction costs two units: the proposal message that carries the buttons, plus the confirmation edit that resolves it — or three, when that edit fails and the `sendText` fallback carries the reply instead. The limiter measures **outbound API calls toward one learner**, not messages, so an edit is charged like any other call.

A denied confirm or cancel writes nothing, so there is no attempt record and nothing for the recovery cron to retry; the learner gets one exempt edit saying the schedule is unchanged and the request was discarded. That edit is not charged — it is the limiter's own answer, and charging it would deny the learner the explanation of their own denial.

A denied menu press is answered the same way, with its own copy, and the button message is left untouched — the handler defers a *new* reply rather than editing the pressed message, so the menu stays usable. A menu mutates nothing, so there is nothing to undo and the learner can simply press again. Admission runs before the upstream WISPACE fetch, so a denied press does not pay for a result it will never show.

Cost per menu press: **1 unit when admitted, 0 when denied.** An admitted press spends its unit even if the upstream fetch then throws and the learner gets the failure message instead of the menu. An unlinked learner spends 1 unit for the canned "not linked" answer, because that answer is still a delivered message.

If Redis fails after startup, one admission fails open with outcome `store_unavailable` and an error log. There is no production in-memory fallback.

This is a containment backstop, not expected steady-state behavior. A
`limited` decision indicates an upstream retry storm or fan-out bug; do not
raise the default cap to hide it.

## Monitoring and recovery

Each bot exposes:

```text
<prefix>_outbound_rate_limit_decisions_total{platform,outcome}
```

Outcomes are `allowed`, `limited`, `store_unavailable`, and `disabled`. The metric has no learner-id labels. First triage is:

1. Check `outcome="limited"` on the metric by platform.
2. Search logs for `Outbound message rate limit exceeded` to find the masked bucket and reason.
3. Inspect scheduled-job/dead-letter rows with `outbound_rate_limited`; do not manually replay them until the burst source is understood.

To temporarily disable the containment gate, set `OUTBOUND_RATE_LIMIT_ENABLED=false` and restart the bot. Re-enable it after the storm is contained; keep the default cap unchanged unless an operator has a measured reason to tune it.
