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
