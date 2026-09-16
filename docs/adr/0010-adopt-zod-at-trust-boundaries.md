# Adopt zod at the LLM and WISPACE Trust Boundaries

## Status

Accepted (#678)

## Context

Three representations of each agent tool are hand-maintained separately today in `packages/llm-agent/src/agent.tools.ts`: the JSON Schema in `AGENT_TOOLS` (8 tools), the TypeScript argument type, and the runtime checks in `parseAndValidateToolArguments` (line 361). Every tool change must touch all three; they drift.

LLM structured output (report, reminder, classifier) goes through a hand-rolled path: `response_format: json_object`, then `JSON.parse`, then a partial shape check, then a template fallback. The shape check is duplicated per call site.

The WISPACE API boundary validates responses only partially: 3 of 7 clients run `validateShape` (`user-goals-api`, `task-score-average-api`, `reengagement-api`); the rest parse `payload: unknown` with hand-rolled guards or none at all. Issue #678 recorded this as "2 of ~7" — the real number is 3 of 7.

The OpenAI SDK already declares an optional peer dependency on `zod ^3.25 || ^4.0`; zod is not yet installed in the tree. This decision makes it a direct dependency at the boundaries where the runtime type of untrusted data must be established.

## Decision

Adopt **zod v4** as the runtime schema library at exactly three trust boundaries, and record where it deliberately must not go.

### In scope

| Boundary                                                                                                                         | What zod replaces                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LLM tool-argument validation + tool-definition JSON Schema derivation (`packages/llm-agent`)                                     | The hand-written JSON Schema in `AGENT_TOOLS` + the TS arg type + `parseAndValidateToolArguments` collapse into one zod schema per tool; JSON Schema derived via `z.toJSONSchema()` (the reason for v4) |
| LLM structured-output parsing (`packages/llm-agent`, `packages/student-report`, the content classifier in `packages/chat-agent`) | Hand-rolled `JSON.parse` + per-call-site shape checks                                                                                                                                                   |
| WISPACE API response validation (`packages/wispace-client`)                                                                      | `validateShape` and hand-rolled `unknown` guards; coverage extends from 3 of 7 clients to all 7                                                                                                         |

### Out of scope — deliberately

- **`packages/contracts`** must stay zero-dependency (verified: no dependencies, no devDependencies, no peerDependencies). Types stay plain; zod schemas live in consuming packages and `z.infer` yields structurally-compatible types.
- **`packages/chat-metering`** may depend only on `typeorm` + `@wispace/llm-agent` per its clean-architecture rule — no zod.
- **NestJS HTTP DTOs in the apps** keep `class-validator` (idiomatic `@Body()` + `ValidationPipe` integration). This includes the shared ops routes in `packages/bot-common`, which are HTTP DTOs despite living in a package.

### Failure semantics differ per boundary — this is intentional

- **WISPACE responses — fail-closed.** A required field missing or mistyped throws into the existing error/retry path. **Extra fields are tolerated** (additive upstream changes must not break the bot): they never fail validation, but the parsed output strips undeclared keys — consumers read declared fields only.
- **LLM structured output — degraded.** A zod parse failure keeps the existing template fallback + log + metric. WISPACE data must be right; LLM output must be sent. Zod replaces the validation layer, not the degradation semantics.
- **LLM tool arguments — unchanged.** Invalid args return an error to the model (current `parseAndValidateToolArguments` behavior); zod is the single validator, not a behavior change.

### Adapter split for structured output

`zodResponseFormat()` is an OpenAI-only API. The OpenAI adapter uses vendor-enforced structured outputs; OpenAI-compatible adapters keep JSON mode + zod parse in our code. The two validation libraries co-exist (zod at these boundaries, class-validator at HTTP DTOs); this repo consolidates onto one **on trigger**, not on a date: **when an HTTP DTO needs to share its schema with a zod boundary.**

That is the whole trigger, and it is deliberately the only one. It fires from inside the codebase — a developer reaches for a schema that already exists on the other side of the fence and finds it in the wrong library — so it cannot go unnoticed. An earlier draft added "or when `nestjs-zod` reaches feature parity"; that clause was removed on 2026-09-16 because it named no owner, no definition of parity, and no review date, which made it a trigger nobody could ever observe firing. Adopting `nestjs-zod` remains available as a normal proposal; it is simply not a standing condition of this ADR.

### Declaration convention

zod is declared per-package in `packages/llm-agent`, `packages/student-report`, `packages/chat-agent`, `packages/wispace-client` — matching each package's existing dependency style. No root hoisting.

## Alternatives considered

| Alternative                                                | Reason for rejection                                                                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Keep hand-rolling all three representations                | The status quo; three drift surfaces per tool and per endpoint                                                         |
| Adopt zod for HTTP DTOs too, drop class-validator now      | NestJS `ValidationPipe` integration is the idiomatic path; swapping every app DTO in one step is a large unforced move |
| zod v3                                                     | No native `z.toJSONSchema()`; the JSON Schema derivation is the core payoff                                            |
| Structured outputs via `zodResponseFormat` on all adapters | OpenAI-compatible providers (gateways, self-hosted) do not uniformly implement it; requiring it excludes them          |

## Consequences

- **Positive**: one schema per tool/endpoint/output; `z.infer` gives the TS type for free.
- **Positive**: 4 uncovered WISPACE clients gain response validation.
- **Negative**: a new dependency in three framework-agnostic packages (`llm-agent` core stays framework-free but now transitively ships zod to consumers via the tool schema module; the OpenAI SDK already pulls zod into the tree when its peer is installed).
- **Negative**: two validation libraries co-exist until a trigger fires — deliberate, bounded by the trigger wording above.
- **Enforcement**: this ADR adds the ratchet — **no new hand-rolled schemas or parsers at the three in-scope boundaries**; existing hand-rolled code migrates only through the implementation issues below, not opportunistically. The CI guard blocking zod in `contracts`/`chat-metering` is `.github/scripts/check-zod-boundary-imports.sh` (#1053).

## Scope

- **This ADR (#678)**: the decision, boundaries, exclusions, semantics, and the ratchet — plus a follow-up issue for the dependency guard script.
- **#679**: make each agent tool one zod schema — derive JSON Schema, arg type, and runtime validation from it.
- **#656**: contract-drift hardening at the WISPACE boundary (shape-validate auth responses, byte caps).
- **#460**: structured-output work in `@wispace/student-report`.
- **#487**: ops bodies skip `ValidationPipe`. **Resolved as class-validator, not zod** (2026-09-16). The original "candidate zod-pipe fix" wording was wrong on the mechanism: the defect is a `body?: unknown` metatype on the shared `PlatformOpsController` route, which `ValidationPipe` skips and a zod pipe would skip for the same reason. Swapping libraries there would fire the consolidation trigger above for a reason unrelated to why the trigger exists. #487 was also re-scoped after a re-read: most of its original evidence is stale at HEAD.

Implementation issues must not start until this ADR is merged. Decided in the 2026-09 hand-rolled-vs-stdlib validation review (#659 thread).
