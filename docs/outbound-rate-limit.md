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

The gate is immediately before learner-facing provider delivery. Chat, fallback/clarification, reminders, reports, templates, welcome/link/consent/reschedule messages, and dead-letter replay are covered. Typing/mark-seen signals and Discord server-channel messages are not covered.

Each provider attempt, retry, or message chunk consumes one unit. A multi-message send is admitted atomically; if the whole batch does not fit, no partial batch is sent. A denial is terminal for that delivery: chat refunds its inbound quota and completes the queue/inbox without fallback or retry; reminder/report/dead-letter paths record `outbound_rate_limited` and do not retry.

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
