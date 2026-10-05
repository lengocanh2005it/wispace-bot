# WISPACE Bots

Shared vocabulary for the three student bots (Messenger, Discord, Zalo) that deliver AI reports, study reminders and rate-limited chat. These terms describe what the platform knows about a message it tried to send — the distinction that decides whether a retry is safe.

## Delivery outcome

**Confirmed non-delivery**:
The provider told us the message was not accepted, so a retry cannot duplicate it.
_Avoid_: failed, unsent, dropped

**Ambiguous delivery**:
The send was attempted and no verdict came back — the provider may or may not have accepted it. Retrying risks a duplicate, so the decision to resend belongs to the caller and the outcome is recorded as a distinct one.
_Avoid_: failed, retriable, unknown

The two are mutually exclusive and exhaust the cases a send can end in. Every outbound path must classify into one of them; a classification that silently falls through to "not sent" turns a lost verdict into a lost message.

## Quota owner

**Quota owner**:
The single component per platform that reserves quota for a chat batch. Today and going forward that is the chat pipeline — never the chat processor, the queue, or a per-platform adapter. Two layers reserving for one batch is a defect, not a defense.
_Avoid_: rate-limit check, pre-reserve

## Chat flush outcome

One reserved quota slot maps to exactly one outcome. Every chat flush ends in one of these four; an unexpected provider error is classified **failed** at the caller boundary — the flush rethrows after firing `onError`.

**Delivered**:
The message was sent and the provider accepted it. The quota slot is consumed. Terminal.
_Avoid_: sent, ok, success

**Denied**:
The quota guard rejected the batch before any send — no turn ran, no quota slot consumed. Terminal for this batch; the learner gets the deny notice through `onQuotaDenied`.
_Avoid_: rate-limited, throttled, blocked

**Duplicate**:
The same delivery key was already in flight or completed, so the pipeline reserved no second slot and ran no turn. Terminal and silent — never a deny notice.
_Avoid_: in-flight, conflict, skipped

**Failed**:
Reserve succeeded but the turn errored before a confirmed send. The slot is refunded and the outcome is retryable through the failed-flush durability path.
_Avoid_: error, unsent, dropped

## Retry boundary

**Caller cancellation**:
Something upstream deliberately stopped the send — a superseded job, an expired lease, a scope that has ended. Terminal: never retried, and excluded from provider-health accounting so one learner cancelling cannot open a shared circuit.
_Avoid_: abort, timeout, user cancel

**Per-attempt timeout**:
One attempt exceeded its own deadline while the caller was still waiting. It is ambiguous by default — the provider may already hold the message — so it is **not** automatically retryable; it becomes retryable only where the provider deduplicates on a delivery key (Discord), and stays terminal otherwise.
_Avoid_: abort, deadline, timeout

Classified by which deadline fired, never by inspecting the error — a provider that aborts its own request reports an indistinguishable error whether the deadline was ours or the caller's. Because no Discord send path carries a caller signal, the Discord adapter owns its only deadline and names the cause itself ([ADR-0053](docs/adr/0053-discord-send-timeout-lives-in-the-transport-adapter.md)). Where a caller signal does exist — the LLM boundary — [ADR-0033](docs/adr/0033-llm-timeout-and-cancellation-semantics.md) settles it by comparing the attempt signal against the caller signal, and its "retryable" conclusion holds there only because an LLM call is idempotent and a chat message is not.

## Deduplication

**Delivery key**:
A stable identifier derived from the message's identity and reused verbatim across every resend of that same message. Where the provider deduplicates on it, an ambiguous delivery can be resent safely; where it does not, an ambiguous delivery must be treated as terminal.
_Avoid_: nonce, idempotency key, dedupe key

Discord is the only platform with a provider-side dedupe key, which is why its ambiguous resend is safe and Messenger's and Zalo's is not.

## Startup

**Fail-closed constraint**:
A rule on configuration or wiring that the application refuses to start on. It is not a warning and not a runtime fallback: the process ends before serving traffic, and a warning-class rule is deliberately not one of these. A constraint that is only reached on first use of a lazy component is not a fail-closed constraint, because nothing refuses to start on it.
_Avoid_: startup check, validation error, guard

**Configuration staleness**:
A stored configuration value that no longer satisfies a fail-closed constraint, usually because the constraint was tightened after the value was written. The value is valid on its own terms; only the code's expectation of it has moved. Nothing detects this until the value is evaluated, which is why it survives indefinitely and surfaces as a deploy failure rather than as drift.
_Avoid_: configuration drift, misconfiguration, invalid config

Drift is a different axis and keeps its existing meaning: divergence between two stores that are both live at runtime. Staleness is one artifact versus a code constraint, with only one live participant.

**Startup validation**:
The deploy phase that evaluates the release image's configuration against the fail-closed constraints before any traffic is switched, reporting every offending key in one pass. It re-invokes the same constraints the application enforces; it does not boot the application to discover them, so it reaches no database, no Redis, and no vendor API. Distinct from the **migration preflight**, which is the pre-migration dump and writer assertion — the word "preflight" belongs to that older phase and not to this one.
_Avoid_: preflight, config check, dry run, smoke test
