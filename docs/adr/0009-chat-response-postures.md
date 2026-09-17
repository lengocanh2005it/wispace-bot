# Chat Response Postures — Bound the Prompt Core Against an Unbounded Input Space

## Status

Proposed (implementation lands with #974 and #982; the precedence line is written into `CHAT_SYSTEM_PROMPT_CORE` by #974)

## Context

`CHAT_SYSTEM_PROMPT_CORE` (`packages/llm-agent/src/chat-system-prompt.ts`) is the free-form chat prompt shared by all three bots. It currently carries nine sections, and each one was added the same way: a class of learner message was found to be handled badly, and a section describing that class was appended. Scope, study stress (#598), academic integrity (#628), non-disclosure (#625), tool gating, multi-intent, personal-data grounding, general style, rescheduling.

The learner input space is unbounded. The section list is not, and cannot be: the file header already records a size budget raised twice (5,000 → 5,300 → 5,800 chars), with a comment stating that raising it again must be deliberate. Two more classes are queued — hostility and abuse (#974), crisis and self-harm (#982). Continuing to add one section per class has three costs that compound:

1. **The budget.** Every section competes with every other for a fixed instruction-following budget. A prompt that says twenty things reliably says none of them.
2. **Pairwise interference grows quadratically.** Branches overlap on real messages, and each overlap has to be adjudicated somewhere. #982 exists because of exactly this: `DISTRESS_PATTERNS` matches `/bo\s*cuoc/`, so a message disclosing crisis is routed to the study-stress branch and answered with advice to lower the session load. Written as pairwise clauses, branch N needs N−1 "must not be swallowed by" statements.
3. **Nobody can enumerate the input space.** Sections are written from imagined messages, so the list drifts toward what an author thought of rather than what learners send.

The framing error is treating the section list as a cover of the input space. It is not, and it was never going to be. The scope section is already a default-deny catch-all: out-of-scope content is not answered, and the assistant is told not to act as a general-purpose assistant. Every unanticipated message already has a destination.

The other sections exist for a narrower reason: at that specific input, the default produces an answer the product disagrees with.

- Study stress: the default is correct policy but cold, and pushes away a learner who is struggling.
- Academic integrity: the default does not fire at all, because essay writing is inside scope.
- Crisis: the default is both cold and unsafe.

That is a much smaller set than "kinds of message a learner might send", and it grows far more slowly.

## Decision

Describe chat behaviour as a **closed set of response postures** plus a **single precedence order**, and gate new prompt sections behind an explicit test.

### The postures

Unbounded input, bounded output. Every turn resolves to exactly one of:

| # | Posture | When |
| --- | --- | --- |
| 1 | Answer normally | In-scope IELTS Writing / WISPACE question needing no personal data |
| 2 | Call a tool, then answer | The learner asks about their own progress, schedule, goals or scores |
| 3 | Scope redirect | Out of scope, and the default is the right answer |
| 4 | Acknowledge, then one WISPACE step | Study stress, discouragement, burnout (#598) |
| 5 | Refuse, then offer the alternative | Ghost-writing a submission (#628); generating abusive content about a third party (#974) |
| 6 | Fixed non-disclosure line | Anything about the assistant's internals (#625) — identical wording every time |
| 7 | De-escalate | Hostility aimed at the assistant (#974) |
| 8 | Hand off to a support resource | Crisis or self-harm disclosure (#982) |
| 9 | Ask for clarification | Ambiguous or empty input (`isAmbiguousMessage`) |

The set is closed. Adding a posture is an amendment to this ADR, not a prompt edit.

### One precedence order

Stated once in the prompt core, in this order, highest first:

```
crisis > non-disclosure > academic integrity > abuse > study stress > scope redirect > tool call > normal answer
```

Individual sections do not restate their relationship to other sections. A new branch inserts itself into this list and writes no pairwise exclusion clauses. Note that crisis outranks study stress, which is the ordering #982 depends on, and that non-disclosure sits high because a varying answer is itself a leak.

### The test for adding a section

> A new prompt section is justified only when the default posture produces an answer that is **harmful or clearly wrong** for that input — not merely imperfect, ungraceful, or unanticipated.

We do not enumerate learner messages. We enumerate the places where we disagree with the base model's default, which is a smaller and slower-growing set. The base model already handles the long tail; the prompt exists to override it where the product needs something different.

### Evidence comes from traffic, not imagination

A section proposed without evidence is a guess about the input space. The evidence for one is a reviewed sample of real messages that took the default posture and were answered badly. `llm_safety_events` already stores redacted excerpts plus hashes (#122), and the input classifier's shadow window (#649) already produces a reviewable stream. Sampling replaces enumeration.

For **#982**, the reviewed incident report records a first-person life-safety disclosure that matched the study-stress posture and received study advice before a crisis posture existed ([issue #982](https://github.com/lengocanh2005it/wispace-bot/issues/982)). The crisis fixtures are regression cases for that reviewed failure, not the evidence for adding the posture.

## Alternatives considered

| Alternative | Reason for rejection |
| --- | --- |
| Keep appending one section per input class | The status quo. Blows the budget, needs N−1 pairwise clauses per new branch, and never converges because the input space is unbounded |
| Move every branch decision into the input classifier | The classifier is off by default, is Messenger-only today (#864), and fails open by design. Behaviour that must always hold cannot depend on an optional tier |
| A per-category rules engine in front of the LLM | Rebuilds classification the model already does, in regex, in one language. `OFF_TOPIC_PATTERNS` shows the ceiling: an unmaintainable list that only covers Vietnamese |
| Split the core prompt into per-category files composed at runtime | Moves the size problem without solving it; the composed prompt is the same length, and precedence becomes implicit in file order |

## Consequences

- **Positive**: New unanticipated input classes need no change — the default posture already covers them, and the test for a new section is explicit rather than a matter of taste
- **Positive**: The precedence line replaces the pairwise exclusion clauses that would otherwise grow quadratically; #982 becomes an insertion into an ordered list instead of a special case
- **Positive**: The posture table gives eval fixtures a target — a case asserts which posture a message takes, rather than asserting prose
- **Positive**: The size budget has a defensible basis: the sections are the recorded disagreements with the base model, not an attempted taxonomy of learner intent
- **Negative**: Precedence stated once is a single point of failure — if the model misreads the order, several branches misfire together, so the ordering needs its own eval cases
- **Negative**: The posture set being closed means a genuinely new posture costs an ADR amendment, which is friction by design and will occasionally be the wrong call
- **Negative**: Sampling real traffic for evidence needs a review habit that does not exist yet; without it, the evidence rule degrades into "no new sections ever"
- **Negative**: Postures 5, 7 and 8 all decline to do what was asked. Learners will not perceive them as distinct, so their copy must stay coordinated even though the sections are separate

## Scope

- **This ADR**: the posture set, the precedence order, the test for adding a section, and the evidence rule
- **#974**: writes the precedence line into `CHAT_SYSTEM_PROMPT_CORE` and adds postures 5 and 7 for abuse
- **#982**: adds posture 8, inserting `crisis` at the top of the precedence order rather than writing its own exclusion clause
- **Not in scope**: the classifier taxonomy. Its labels stay a separate concern; the mapping from a classifier label to a posture is a lookup, and `runInputClassifier`'s current `reason.includes('extraction')` special case should become that lookup when a fifth label lands
