---
status: accepted
decided: 2026-09-27
issue: 778
---

# Decomposition is driven by duplicated responsibilities, not by file size

A file is a decomposition candidate when it mixes responsibilities that can be
named, or when the same responsibility is implemented more than once. Line count
is evidence, not a trigger: it does not distinguish a cohesive 900-line module
from a 400-line class holding four unrelated ones, and it re-admits the files it
was written to catch.

## Context

#778 was filed on 2026-09-04 with a threshold — "decompose every file over ~780
lines" — and was re-measured four times since (2026-09-08, 09-12, 09-13, 09-15).
Each revision corrected the line counts and the scope list. None of the four
revocations changed the principle, so the correction cost kept being paid and
the issue kept needing maintenance.

Re-measuring the five remaining files on 2026-09-27 with a raw line count:

| File | In #778 | Measured (raw / non-blank) |
| --- | ---: | ---: |
| `packages/bot-metrics/src/bot-metrics.service.ts` | 1169 | **1412 / 1260** |
| `packages/chat-agent/src/chat-queue/redis-chat-queue.store.ts` | 1168 | 1168 / 1074 |
| `packages/chat-agent/src/agent/platform-agent.service.ts` | 1036 | **1187 / 1122** |
| `apps/messenger-bot/.../messenger-chat-processor.service.ts` | 960 | 973 / 921 |
| `packages/chat-metering/src/chat-rate-limit/chat-rate-limit.repository.ts` | 829 | **1004 / 930** |

Four of the five were understated, two of them by 21%. No combination of raw and
non-blank counting reproduces the published figures, so the numbers were not
merely a different counting convention.

The precedent the issue offers as proof of approach also fails its own
criterion. #778 records `agent.service.ts` as "2123 → 859, −59%, done". Measured
on 2026-09-27 that file is **996 lines**, and the four collaborators #438
extracted into `packages/llm-agent/src/internal/` total **1196 lines**
(`agent-limits.ts` 133, `context-manager.ts` 366, `safety-pipeline.ts` 227,
`tool-round-executor.ts` 470). 996 + 1196 = 2192 against a 2123 pre-split
figure, so the split left the service **above** the 780 threshold and left the
codebase with slightly *more* lines, not 59% fewer. Extraction moved a
responsibility out of a class; it never reduced total code.

The two replacement criteria both proposed in review were then measured against
the real files and both failed.

Constructor dependency count, proposed on 2026-09-12 as an alternative to LOC,
was falsified by the worst offender:

```ts
constructor(config: MetricsConfig) {
  this.prefix = config.prefix;
  this.tracer = config.tracer;
  ...
}
```

`bot-metrics.service.ts` carries one constructor dependency while holding 77
public methods, roughly 540 lines of metric declaration, and eight unrelated
metric domains. A criterion that scores the repository's largest offender a 1
cannot detect it.

The binding constraint was also not the one the issue named. The five files
total 5744 lines of source against **10261 lines of spec** — 1.8:1, and 3.7:1
for `platform-agent.service.ts`, whose three specs are larger than the service
by more than 3000 lines. Splitting these files is therefore a decision about
where 10261 lines of test go, not a mechanical move of 5744 lines of source.

## Outcome

Decomposition is triggered by a named responsibility seam or by duplicated
implementation, and is recorded as a per-file plan against a named duplication
issue. Line count is reported as evidence alongside a finding and is never a
gate.

The two criteria that failed are recorded so they are not re-proposed: file size,
because its own precedent did not meet it and its numbers were wrong; and
constructor dependency count, because the largest offender in the repository has
one dependency.

#778 becomes an index rather than a work queue. It names, for each file, the
duplication issue that already owns it or the reason it is kept. Four of the
five files have no owner, and they stay that way until a duplication finding
appears — which is the point: they were selected by a scan, not by pain.

## Why not an oxlint size rule

`.oxlintrc.json` sets `categories.correctness` to `off` and enumerates roughly a
hundred rules explicitly. No size or complexity rule is among them, so adding
one is a deliberate configuration decision rather than a default that drifted.

`max-lines` is available and is still the wrong tool. A ratchet — fail only on
growth, tolerate the existing backlog — cannot be expressed in lint config,
because an oxlint `overrides` entry exempts a path unconditionally: a file
exempted while it was 1412 lines stays exempt while it reaches 1600. Ratcheting
would require regenerating the exemption list as files shrink, which is the same
hand-maintained list that drifted four times.

The ratchet therefore lives in a script. ADR-0043 already established that a
rule config cannot express goes into a checked script rather than into
`.oxlintrc.json`; it put that rule inside `check-architecture.mjs`, which is now
979 lines and enforces import edges. Size is a different concern from an import
edge, so the ratchet is a sibling script, `scripts/check-file-size.mjs`, chained
into `verify` and `verify:affected` beside `workspace-deps:check` rather than
added to a file that has its own subject.

It measures the current size of each tracked file and fails when a file grows
past the size recorded for it in `scripts/file-size-baseline.json`, so shrinking
a file earns headroom and growing it is blocked. A file enters the baseline only
when a decision named it, and leaves it when it is decomposed or deleted. A new
file is never gated by size at all.

## Amendment 2026-09-28: an extraction destination may be gated

The Outcome says a new file is never gated by size at all, and the baseline
note repeated it. That rule was written when a new file was incidental — a
helper, a spec — and it does not contemplate a new file that is the
*destination* of a named extraction and the largest single file in its area.
Such a file starts life ungated at whatever size the extraction produced, which
is the one case the ratchet exists to stop and the one case it was blind to.

So the rule is narrowed, not reversed: a file may enter the baseline when it is
the destination of a named extraction, because a decision then names it in the
ordinary way. An incidental new file is still never gated, and a file nobody
has proposed decomposing does not enter the baseline just because it is large.

`clarification-responder.ts` is the first entry under this amendment. Its
thirteen decision rules and its outcome table are one table; splitting it would
re-introduce the half-applied counted-but-not-sent pairing that keeping it whole
prevents.

The baseline note previously said "four of these six have no decomposition
owner". That count was wrong the moment an entry changed hands, which is the
same fragility ADR-0044 rejects for a hand-written line-count list, so the note
now states the steady state instead of a tally.

## Consequences

- A file may stay above any size line. The question asked of a large file is
  which responsibilities it holds and whether they are separable, not how many
  lines it has.
- A measured regression is visible without anyone re-measuring by hand. The
  baseline replaces the four re-measurement passes #778 needed.
- The check rewards reduction rather than reporting it, so a split that moves
  code out and leaves the total flat costs effort and buys nothing. #438 is the
  case: it produced four well-named seams and a larger total.
- `CONTEXT.md` and `CONTEXT-MAP.md` are untouched. This decision moves no
  concept across a boundary, so no glossary entry changes.

## References

- [#778](https://github.com/lengocanh2005it/wispace-bot/issues/778)
- [#438](https://github.com/lengocanh2005it/wispace-bot/issues/438)
- [#1080](https://github.com/lengocanh2005it/wispace-bot/issues/1080)
- [ADR-0043 — Contract ownership taxonomy](0043-contract-ownership-taxonomy.md)
- [ADR-0039 — Automated host scripts distribution and drift detection](0039-automated-host-scripts-distribution-and-drift-detection.md)
