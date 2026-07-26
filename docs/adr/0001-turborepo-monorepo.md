# Turborepo monorepo instead of multi-repo

The bots (Messenger, Discord, Zalo) and shared packages (`llm-agent`, `chat-metering`, `wispace-client`, `chat-history`, `student-report`, `chat-queue-core`, `study-reminder-core`) live in the same repo with npm workspaces + Turborepo, instead of being split into separate repos.

## Rationale

- **Shared code tightly coupled**: `llm-agent` and `chat-metering` change across all three bots. Multi-repo would require continuous version publishing + bumping, creating friction for the POC.
- **Single source of truth for DB schema**: One shared `ai_chat_bot_db`. Multi-repo would need a schema registry or cross-repo migrations.
- **Simple CI/CD**: Turborepo cache + filter (`--filter=@wispace/messenger-bot...`) builds only the relevant parts quickly. No need for another monorepo tool.
- **POC stage**: No need to split teams or have independent deploy pipelines yet. Can reconsider when scaling to production multi-tenant.

## Alternatives considered

| Alternative | Reason for rejection |
|-------------|---------------------|
| Multi-repo (one repo per bot) | Shared packages would need versioning + publish workflow. Too complex for the POC. |
| Nx monorepo | Good but Turborepo is lighter, faster caching, more npm-native ecosystem. |
| Lerna monorepo | Deprecated, Turborepo is the successor. |

## Consequences

- All apps and packages build in a single pipeline. CI time increases if the repo grows large but is acceptable for now.
- Releases are tightly coupled — one PR can affect all three bots. Careful testing is needed before merging.
- When teams split or independent deploys are needed, will need to move to multi-repo or add independent pipelines.
