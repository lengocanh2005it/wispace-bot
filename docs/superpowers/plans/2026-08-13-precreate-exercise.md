# Precreate Next Exercise Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the linked-learner precreate_next_exercise chat tool to Messenger, Discord, and Zalo, backed by WISPACE's idempotent roadmap-exercise API.

**Architecture:** Keep WISPACE ownership in the existing @wispace/wispace-client anti-corruption layer. Add the tool definition to @wispace/llm-agent, execute it through the shared @wispace/chat-agent service, and inject one platform-configured WispaceExerciseService into each bot. Do not add a database table, queue, outbox, or new bounded context.

**Tech Stack:** NestJS 11, TypeScript, native fetch, AbortSignal, Jest, @wispace/llm-agent, @wispace/chat-agent, @wispace/wispace-client.

**Spec:** docs/superpowers/specs/2026-08-13-precreate-exercise.md

## Global Constraints

- Use POST WISPACE_API_PRECREATE_EXERCISE_URL with an empty body.
- Send the platform externalUserId as x-psid, x-discordid, or x-zaloid; never use Zalo's WISPACE userId for this endpoint.
- Send X-Internal-Key from the existing WISPACE_INTERNAL_KEY.
- Use WISPACE_API_PRECREATE_EXERCISE_TIMEOUT_MS=30000 and a 35-second LLM tool timeout.
- Never automatically retry this POST.
- Map flags in this exact order: no_roadmap, finished_all, already_exists, created.
- Require an absolute HTTPS exerciseUrl for created and already_exists; preserve the validated URL exactly in the tool result.
- Sanitize and length-limit the API message before exposing it as messageHint; flags win over message content.
- Do not call WISPACE for an unlinked account or for a request specifying Task type, exercise topic, or difficulty.
- Keep the result private-data aware so Discord server-channel replies use the existing DM path.
- Do not add persistence, outbox, quota/cooldown, menu, tracking, or reminder behavior.
- Keep .env, tokens, and real API responses out of the worktree and commit.

---

### Task 1: Add the WISPACE exercise client and normalized contract

Files:

- Create: packages/wispace-client/src/types/precreate-exercise.types.ts
- Create: packages/wispace-client/src/clients/precreate-exercise-api.client.ts
- Create: packages/wispace-client/src/clients/precreate-exercise-api.client.spec.ts
- Create: packages/wispace-client/src/clients/wispace-exercise.service.ts
- Modify: packages/wispace-client/src/config/wispace-config.service.ts
- Modify: packages/wispace-client/src/index.ts

Interfaces:

- Produce PrecreateExerciseStatus = 'created' | 'already_exists' | 'finished_all' | 'no_roadmap'.
- Produce PrecreateExerciseResult = { status: PrecreateExerciseStatus; exerciseUrl?: string; message?: string }.
- Produce PrecreateExerciseApiClient.precreateNextExercise(idHeader: WispaceIdHeader, externalUserId: string, options?: { signal?: AbortSignal }): Promise<PrecreateExerciseResult>.
- Produce WispaceExerciseService.precreateNextExercise(externalUserId: string, options?: { signal?: AbortSignal }): Promise<PrecreateExerciseResult>.
- Configure the client through WispaceConfigService.buildPrecreateExerciseClientConfig() using the required URL, shared internal key, maxRetries: 0, and the 30-second timeout env value.

- [ ] Step 1: Write the failing client tests.

  Cover all three id headers with an empty request body, `X-Internal-Key`, and exactly one fetch on failure. Use table tests for the agreed status precedence (`no_roadmap`, `finished_all`, `already_exists`, `created`), reject non-HTTPS or missing URLs when a link is required, and assert that malformed JSON, 4xx, 5xx, 429, timeout, and network failures do not retry.

- [ ] Step 2: Run the focused test to verify it fails.

Run: npx jest --config packages/wispace-client/jest.config.js packages/wispace-client/src/clients/precreate-exercise-api.client.spec.ts --runInBand

Expected: FAIL because the client, normalized contract, and config method do not exist.

- [ ] Step 3: Implement the smallest shared client.

Use buildWispaceHeaders, mergeWithTimeout, readResponseText, and WispaceApiError. Omit body and Content-Type. Parse only the required boolean flags, classify them in the agreed precedence, validate a required https: URL with new URL(), and return the original trimmed URL. Do not call withRetry.

    export class WispaceExerciseService {
      private client?: PrecreateExerciseApiClient;

      constructor(
        private readonly idHeader: WispaceIdHeader,
        private readonly configService: WispaceConfigService,
      ) {}

      precreateNextExercise(
        externalUserId: string,
        options?: { signal?: AbortSignal },
      ): Promise<PrecreateExerciseResult> {
        return this.getClient().precreateNextExercise(
          this.idHeader,
          externalUserId,
          options,
        );
      }
    }

- [ ] Step 4: Export the types and service, then rerun the focused test.

Run: npx jest --config packages/wispace-client/jest.config.js packages/wispace-client/src/clients/precreate-exercise-api.client.spec.ts --runInBand

Expected: PASS, including one fetch call on HTTP failure and rejection of malformed required URLs.

- [ ] Step 5: Commit the client boundary.

  git add packages/wispace-client/src
  git commit -m "feat: add wispace next exercise client"

### Task 2: Register the shared LLM tool contract

Files:

- Create: packages/llm-agent/src/agent.tools.spec.ts
- Modify: packages/llm-agent/src/agent.tools.ts

Interfaces:

- Produce the AgentToolName member precreate_next_exercise.
- Produce an AGENT_TOOLS entry with no parameters and instructions to call only for a clear next-exercise request, never for taskType, exerciseTopic, or difficulty selection.

- [ ] Step 1: Write the failing contract test.

  it('exposes precreate_next_exercise as a no-argument tool', () => {
  expect(AGENT_TOOL_NAMES).toContain('precreate_next_exercise');
  expect(AGENT_TOOLS.find((tool) => tool.name === 'precreate_next_exercise')).toMatchObject({
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  });
  expect(isAgentToolName('precreate_next_exercise')).toBe(true);
  });

- [ ] Step 2: Run the focused test and verify failure.

Run: npx jest --config packages/llm-agent/jest.config.js packages/llm-agent/src/agent.tools.spec.ts --runInBand

Expected: FAIL because the tool name and definition are absent.

- [ ] Step 3: Add the tool name and definition.

Do not add it to SCORE_TOOLS or SCHEDULE_TOOLS; it is a roadmap command, not a score or calendar lookup.

- [ ] Step 4: Run the focused test and commit.

Run: npx jest --config packages/llm-agent/jest.config.js packages/llm-agent/src/agent.tools.spec.ts --runInBand

Expected: PASS.

    git add packages/llm-agent/src/agent.tools.ts packages/llm-agent/src/agent.tools.spec.ts
    git commit -m "feat: register next exercise agent tool"

### Task 3: Execute the shared tool and guarantee the URL in the reply

Files:

- Modify: packages/chat-agent/src/agent/platform-agent.types.ts
- Modify: packages/chat-agent/src/agent/platform-agent-tools.service.ts
- Modify: packages/chat-agent/src/agent/platform-agent.service.ts
- Modify: packages/chat-agent/src/agent/platform-agent-tools.service.spec.ts
- Modify: packages/chat-agent/src/agent/platform-agent.service.spec.ts

Interfaces:

- Add precreatedExerciseUrl?: string to PlatformAgentToolContext.
- Inject optional WispaceExerciseService into PlatformAgentToolsService so Messenger can continue using its override-only construction.
- The shared tool returns { status, exerciseUrl?, messageHint? }, { available: false, message }, or { status: 'unavailable', messageHint: '...' }; it never returns raw API error/body text.

- [ ] Step 1: Add failing tests for the shared execution boundary.

  ```ts
  it('does not call WISPACE when the account is unlinked', async () => {
    const result = await service.execute('precreate_next_exercise', '{}', {
      externalUserId: 'discord-1',
    });
    expect(result).toMatchObject({ available: false });
    expect(exerciseService.precreateNextExercise).not.toHaveBeenCalled();
  });

  it('uses the external id, marks private data, and stores the URL', async () => {
    exerciseService.precreateNextExercise.mockResolvedValue({
      status: 'created',
      exerciseUrl:
        'https://testfrontend.aihubproduction.com/my-roadmap?sequenceIndex=8',
      message: 'Exercise generated',
    });
    const ctx = {
      externalUserId: 'zalo-1',
      userId: 42,
      privateDataFetched: false,
    };

    const result = await service.execute('precreate_next_exercise', '{}', ctx);

    expect(exerciseService.precreateNextExercise).toHaveBeenCalledWith(
      'zalo-1',
      expect.any(Object),
    );
    expect(ctx.privateDataFetched).toBe(true);
    expect(ctx.precreatedExerciseUrl).toContain('sequenceIndex=8');
    expect(result).toMatchObject({
      status: 'created',
      exerciseUrl: expect.any(String),
    });
  });

  it('returns a generic unavailable result without leaking an API error', async () => {
    exerciseService.precreateNextExercise.mockRejectedValue(
      new Error('HTTP 503 secret backend body'),
    );
    const result = await service.execute('precreate_next_exercise', '{}', {
      externalUserId: 'discord-1',
      userId: 42,
    });
    expect(result).toEqual({
      status: 'unavailable',
      messageHint: expect.any(String),
    });
    expect(JSON.stringify(result)).not.toContain('secret backend body');
  });
  ```

Add a PlatformAgentService regression test that has a successful exercise tool result but an LLM final text without the URL, then asserts the returned text contains the exact URL and that the corrected text is the one appended to history.

- [ ] Step 2: Run focused tests and verify failure.

Run: npx jest --config packages/chat-agent/jest.config.js packages/chat-agent/src/agent/platform-agent-tools.service.spec.ts packages/chat-agent/src/agent/platform-agent.service.spec.ts --runInBand

Expected: FAIL because the tool dispatch, context field, and URL guard are absent.

- [ ] Step 3: Implement linked-account execution.

Add a precreate_next_exercise switch branch behind withLinkedAccount. Set privateDataFetched=true before the request, call precreateNextExercise(ctx.externalUserId, { signal }), sanitize the optional message with sanitizeUntrustedTextForLlm({ maxChars: 500 }), and store the validated URL in ctx.precreatedExerciseUrl only for created or already_exists. Catch all client failures inside this branch, log only a masked external ID plus a safe category/status, and return the generic unavailable result.

- [ ] Step 4: Implement the final-link guard.

After this.agent.reply() and before history append, apply this exact behavior:

    function ensurePrecreatedExerciseUrl(text: string, url?: string): string {
      if (!url || text.includes(url)) return text;
      const prefix = text.trim();
      return prefix
        ? prefix + '\n\nMở bài tập tại đây: ' + url
        : 'Mở bài tập tại đây: ' + url;
    }

Return and persist the guarded text. Do not modify replies that did not produce a validated exercise URL.

- [ ] Step 5: Run focused tests and commit.

Run: npx jest --config packages/chat-agent/jest.config.js packages/chat-agent/src/agent/platform-agent-tools.service.spec.ts packages/chat-agent/src/agent/platform-agent.service.spec.ts --runInBand

Expected: PASS, including no-link-on-error and exact-link fallback behavior.

    git add packages/chat-agent/src/agent
    git commit -m "feat: execute next exercise tool safely"

### Task 4: Wire Discord and Zalo to the shared client

Files:

- Modify: apps/discord-bot/src/modules/wispace/wispace.module.ts
- Modify: apps/discord-bot/src/modules/discord-chat/discord-chat.module.ts
- Modify: apps/discord-bot/src/app.boot.spec.ts
- Modify: apps/zalo-bot/src/modules/wispace/zalo-wispace.module.ts
- Modify: apps/zalo-bot/src/modules/zalo-chat/zalo-chat.module.ts
- Modify: apps/zalo-bot/src/app.boot.spec.ts
- Modify: apps/discord-bot/src/shared/prompts/discord-chat.system.txt
- Modify: apps/zalo-bot/src/shared/prompts/zalo-chat.system.txt

Interfaces:

- Register WispaceExerciseService('x-discordid', configService) in Discord and export it from WispaceModule.
- Register WispaceExerciseService('x-zaloid', configService) in Zalo and export it from ZaloWispaceModule.
- Inject the service into each PlatformAgentToolsService factory; the new tool passes ctx.externalUserId, while existing goals/calendar paths keep their current platform behavior.
- Set toolExecutionTimeoutMs: 35_000 in both platform agent options.

- [ ] Step 1: Add module-level regression assertions.

Import WispaceExerciseService in both app boot specs and assert moduleRef.get(WispaceExerciseService) returns an instance after the existing AppModule compile. Extend the shared tool test to verify Zalo passes zalo-1, not String(ctx.userId).

- [ ] Step 2: Run focused package/app tests and verify the new wiring fails.

Run: npx turbo run test --filter=@wispace/chat-agent... --filter=@wispace/discord-bot... --filter=@wispace/zalo-bot...

Expected: FAIL or typecheck failure because the new provider and constructor argument are absent.

- [ ] Step 3: Add the providers, exports, injections, and 35-second timeouts.

Keep the current wispaceExternalId option unchanged for existing Zalo goals/calendar behavior; the new exercise branch must use ctx.externalUserId directly.

- [ ] Step 4: Update Discord/Zalo prompts.

Add instructions that clear “create/give me a new exercise” requests may call precreate_next_exercise; Task/topic/difficulty-specific requests must not call it; a returned URL must be copied exactly; status results must be paraphrased in Vietnamese; and a server-channel result is private. Remove Zalo's outdated statement that personalized features are unavailable when it conflicts with this new linked exercise capability.

- [ ] Step 5: Run focused tests and commit.

Run: npx turbo run test typecheck --filter=@wispace/chat-agent... --filter=@wispace/discord-bot... --filter=@wispace/zalo-bot...

Expected: PASS.

    git add apps/discord-bot apps/zalo-bot
    git commit -m "feat: wire next exercise tool to discord and zalo"

### Task 5: Wire Messenger's override path

Files:

- Modify: apps/messenger-bot/src/modules/student-report/student-report.module.ts
- Modify: apps/messenger-bot/src/modules/messenger/application/agent/messenger-agent-tools.service.ts
- Modify: apps/messenger-bot/src/modules/messenger/application/agent/messenger-agent-tools.service.spec.ts
- Modify: apps/messenger-bot/src/modules/messenger/chat-pipeline.module.ts
- Modify: apps/messenger-bot/src/shared/prompts/messenger-chat.system.txt

Interfaces:

- Provide and export WispaceExerciseService('x-psid', configService) from StudentReportModule.
- Inject it into MessengerAgentToolsService and add a precreate_next_exercise override.
- The Messenger override checks ctx.userId before calling WISPACE, sends ctx.externalUserId as the PSID, sets privateDataFetched=true for linked requests, sanitizes the advisory message, and returns the same normalized result shape as the shared path.
- Set Messenger toolExecutionTimeoutMs to 35_000 from its current 30-second value.

- [ ] Step 1: Add failing Messenger tests.

  it('does not call the exercise API when Messenger is unlinked', async () => {
  const { service, ctx, exerciseService } = createService({ userId: undefined });
  const result = await service.execute('precreate_next_exercise', '{}', {
  ...ctx,
  userId: undefined,
  });
  expect(result).toMatchObject({ available: false });
  expect(exerciseService.precreateNextExercise).not.toHaveBeenCalled();
  });

  it('calls the exercise API with the Messenger PSID', async () => {
  const { service, ctx, exerciseService } = createService({
  precreateNextExercise: jest.fn().mockResolvedValue({
  status: 'already_exists',
  exerciseUrl: 'https://testfrontend.aihubproduction.com/my-roadmap?sequenceIndex=8',
  message: 'already generated',
  }),
  });
  await service.execute('precreate_next_exercise', '{}', ctx);
  expect(exerciseService.precreateNextExercise).toHaveBeenCalledWith('psid-123', expect.any(Object));
  });

- [ ] Step 2: Run the focused Messenger spec and verify failure.

Run: npx jest --config apps/messenger-bot/jest.config.js apps/messenger-bot/src/modules/messenger/application/agent/messenger-agent-tools.service.spec.ts --runInBand

Expected: FAIL because the Messenger constructor, override, and test factory do not yet know the exercise service.

- [ ] Step 3: Implement the provider and override.

Reuse the shared WispaceExerciseService and the existing MESSENGER_NOT_LINKED_MESSAGE; do not duplicate HTTP code or bypass the shared header builder.

- [ ] Step 4: Update the Messenger prompt and timeout, then run focused tests.

Run: npx turbo run test typecheck --filter=@wispace/messenger-bot...

Expected: PASS.

- [ ] Step 5: Commit the Messenger wiring.

  git add apps/messenger-bot
  git commit -m "feat: wire next exercise tool to messenger"

### Task 6: Add shared environment and agent-facing documentation

Files:

- Modify: .env.shared.example
- Modify: docs/project-overview.md
- Modify: AGENTS.md

Interfaces:

- Document WISPACE_API_PRECREATE_EXERCISE_URL=https://testbackend.aihubproduction.com/api/roadmap/precreate-exercise.
- Document WISPACE_API_PRECREATE_EXERCISE_TIMEOUT_MS=30000.
- Document the three platform headers, idempotency, no automatic retry, linked-account requirement, and the fact that the feature creates only the next roadmap exercise.

- [ ] Step 1: Add the two shared env examples.

Place them beside the existing WISPACE API URL and retry settings in .env.shared.example; do not add a real secret or edit any .env file.

- [ ] Step 2: Update the project overview and agent routing notes.

Add the endpoint to the shared WISPACE API list and add the feature to the chat/tool routing section. Explicitly record the future taskType/exerciseTopic extension and that the current API accepts no selection parameters.

- [ ] Step 3: Run format checks on documentation.

Run: npx prettier --check .env.shared.example docs/project-overview.md AGENTS.md

Expected: PASS.

- [ ] Step 4: Commit the configuration and documentation.

  git add .env.shared.example docs/project-overview.md AGENTS.md
  git commit -m "docs: document next exercise integration"

### Task 7: Full verification and controlled test handoff

Files:

- Verify the complete worktree diff; no new source files are added in this task.

Interfaces:

- The worktree must contain only the agreed feature, its tests, the spec/plan, and the previously-created domain glossary updates.

- [ ] Step 1: Inspect the final diff for scope and secrets.

Run:

    git status --short --branch
    git diff --check
    git diff --stat
    git diff --name-only

Expected: no .env, token, API key, raw learner ID, or unrelated file appears.

- [ ] Step 2: Run the required verification order from the worktree root.

Run:

    npm ci
    npm run format:check
    npm run lint
    npm run typecheck
    npm run test
    npm run build

Expected: every command exits 0. Fix failures before claiming completion.

- [ ] Step 3: Run one controlled test account per platform.

With the test URL and test credentials configured outside git, send a clear request from one linked Messenger, Discord, and Zalo account. Verify the correct header at the WISPACE boundary, one generated link, a repeated request returning the existing link, and no duplicate exercise. Do not run this against production or an account whose roadmap state must not change.

- [ ] Step 4: Commit the verified plan/spec state if execution used task commits.

Run: git status --short --branch

Expected: the worktree is either clean after the task commits or has only intentionally-uncommitted review changes; do not push or merge from this plan.
