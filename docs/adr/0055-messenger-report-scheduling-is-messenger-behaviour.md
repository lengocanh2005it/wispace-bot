---
status: proposed
---

# Messenger report scheduling is Messenger behaviour, not a feature module of its own

Evaluated on 2026-10-06 in [#1446](https://github.com/lengocanh2005it/wispace-bot/issues/1446) and recorded here so the decision survives the issue being closed. **The decision is taken; no code has moved yet.** The fold lands in the first of three PRs, and this record stays `proposed` until it does.

`apps/messenger-bot/src/modules/scheduler` is the only feature module in the repository with no bounded context behind it. `CONTEXT-MAP.md` names seven — Platform Interaction, Account Linking, Learning Data ACL, Free-form Chat, Study Reminder, Student Report, Metering & Operations — and none of them is a scheduler. The directory holds the daily report wave, its retry dispatch, report orchestration, and the ops-health and data-quality snapshots: Student Report and Metering & Operations vocabulary spread across a boundary nobody declared. Discord and Zalo never had the module. Their report crons live inside their chat feature module, and both run the wave through the shared `ReportOrchestrationService` in `@wispace/scheduler-core`.

The cost is measurable. The scheduler decided *when* to act while reaching into `messenger`'s concrete services to decide *how to send`, which is what `CONTEXT-MAP.md` rule 5 forbids: 5 concrete imports across 2 files, plus 5 more into `chat-rate-limit` and `study-reminder`. It also left two DI bindings — `REPORT_CLAIM_REPOSITORY` and `MESSENGER_REPORT_SENT_READER` — in `messenger/messenger-outbound.module.ts` for classes that lived in the scheduler, the binding-location defect `docs/architecture-boundaries.md` names as its own failure mode. And it kept messenger-bot outside the cross-feature import rule that `discord-bot` and `zalo-bot` have been under since #1445, because that rule has no exemption list by design and these edges could not be grandfathered.

## The shape the fold has to take

Messenger's report scheduling folds into the `messenger` feature module's **own layer directories**. It does not become a nested `messenger/report-schedule/` folder: `module-layout-unclassified` classifies by the first path segment, so `messenger/report-schedule/application/report-producer.ts` has a first segment of `report-schedule`, is not a composition root, and is reported as sitting outside the architecture rules entirely (`docs/architecture-boundaries.md`, "a file placed in a subdirectory of a feature module that is not a layer directory"). A folder nested inside a feature module is invisible to the layer rules rather than covered by them — it would trade 5 real violations for a new class of unchecked file.

What Discord actually does is the flat version. `discord-chat/discord-report.module.ts` is a second Nest module file at the **feature root**, not inside a subdirectory. So the fold produces `messenger/messenger-report-schedule.module.ts` and `messenger/report-producer.ts` at the feature root, beside the five module files already there, with the services, domain types and controller landing in the `application/`, `domain/`, `infrastructure/` and `presentation/` directories they already use. That is also where both sibling bots keep their producer descriptor.

The files move; the dependency graph inside them does not. `CONTEXT-MAP.md` gains the boundary rule that was missing, and #1447 then opens the rule for messenger-bot once the remaining clusters are gone.

## Considered options

- **Declare `scheduler` a context and give it a `CONTEXT.md`** — rejected. Its language already has owners: the report window and the report content are Student Report's, and `ops:health` / `ops:data-quality` are Metering & Operations'. A third owner would describe no decision, and the context map would gain a row that asserts ownership rather than recording it. What was actually unowned is the wave itself — who runs it, and when — which is the gap rule 7 fills.
- **Nest it as `messenger/report-schedule/`** — rejected on evidence, not taste. It reads tidier and it is what the issue first proposed, but it lands the whole subtree outside the layer rules.
- **Keep the module and invert the dependencies behind new ports** — rejected. It leaves a context-free directory still asserting a boundary, with a new port whose only implementation is a class inside the feature it was meant to hide. The checker would go green without the boundary becoming true.
- **Move the cron logic into `@wispace/scheduler-core`** — rejected for this change, and already tracked as [#469](https://github.com/lengocanh2005it/wispace-bot/issues/469). `scheduler-core` already owns the platform-neutral policy, and Messenger deliberately does not use its `ReportOrchestrationService`, which both sibling bots do. That migration changes claim and lease transitions, so it needs its own parity evidence; folding the folder does not require it.
- **Rename the module to `messenger-scheduler`** — rejected. It keeps the same false boundary under a clearer name.
- **Grandfather the edges behind a per-edge allow-list** — rejected. `docs/architecture-boundaries.md` states there is no baseline, ratchet, or allow-list, and this checker already had one removed (#1088). A per-edge list is a permanent shelf.

## Measurement correction

An earlier version of #1446 counted 20 production imports from `scheduler` into `messenger` as its blocking set. `feature-module-cross-import` exempts two shapes: an import landing on a port — a `ports/` directory segment or a `.port.ts` file — and an import from a composition root. Measured with the checker's own predicates, that module reaches `messenger` in **18** production import statements: **5 concrete**, **13 already legal**. Messenger-bot's real total is **23** concrete imports across 4 of its 10 feature modules. The fold removes 5; the other 18 belong to clusters #1447 lists.

Not a cosmetic correction. An issue that overstates its own blocking set by 2.6× invites a solution to the wrong problem, which is what the ports-first proposal was.
