# Turborepo monorepo instead of multi-repo

The bots (Messenger, Discord, Zalo) and the shared packages under `packages/` live in the same repo with npm workspaces + Turborepo, instead of being split into separate repos.

## Rationale

- **Shared code tightly coupled**: `llm-agent` and `chat-metering` change across all three bots. Multi-repo would require continuous version publishing + bumping, creating friction for this stage.
- **Single source of truth for DB schema**: One shared `ai_chat_bot_db`. Multi-repo would need a schema registry or cross-repo migrations.
- **Simple CI/CD**: Turborepo cache + filter (`--filter=@wispace/messenger-bot...`) builds only the relevant parts quickly. No need for another monorepo tool.
- **At the time of this decision**: No need to split teams or have independent deploy pipelines yet. Can reconsider when scaling to production multi-tenant.

## Alternatives considered

| Alternative | Reason for rejection |
|-------------|---------------------|
| Multi-repo (one repo per bot) | Shared packages would need versioning + publish workflow. Too complex at this stage. |
| Nx monorepo | Good but Turborepo is lighter, faster caching, more npm-native ecosystem. |
| Lerna monorepo | Deprecated, Turborepo is the successor. |

## Consequences

- The monorepo still supports a single Turborepo build graph, while CI/CD uses independent per-bot jobs with path filtering and a shared Docker build/deploy workflow. Production images use `deploy/Dockerfile.bot` and hardened non-root runtime settings. CI time increases if the repo grows large but is acceptable for now.
- Shared-package changes can affect all three bots; app-only changes are built and deployed independently. Careful testing is needed before merging.
- Independent per-bot CI/CD is implemented. Moving to multi-repo remains an option if team ownership or release boundaries eventually require it.
