import { PlatformAgentService } from '@wispace/chat-agent';
import {
  RescheduleRecoveryCronService,
  TypeormRescheduleStore,
} from '@wispace/reschedule-confirm/adapters';
import {
  ChatPipelineModule,
  MESSENGER_AGENT_OPTIONS,
} from './chat-pipeline.module';
import type { FactoryProvider } from '@wispace/bot-common/testing';
import {
  findEffectiveFactoryProvider,
  findFactoryProvider,
} from '@wispace/bot-common/testing';

/**
 * #1127: `PlatformAgentService` and its classifier options are no longer
 * hand-written here — the shared factory builds the service from this module's
 * `MESSENGER_AGENT_OPTIONS` binding. Reach both by token so the specs keep
 * their intent without depending on an argument position.
 *
 * The lookup goes through `findEffectiveFactoryProvider` rather than a local
 * `.find()`: the last binding is the one Nest resolves, and a first-match lookup
 * keeps reporting green after the binding it read is deleted (#1507). The helper
 * also checks each call's arity against the provider's own `inject`.
 */
const bindingFor = (token: unknown): FactoryProvider => {
  const binding = findEffectiveFactoryProvider(ChatPipelineModule, token);
  expect(binding).toBeDefined();
  return binding!;
};

/**
 * The nine messenger-local options, with a classifier built against the
 * approved model — the state the #864/#868 tests care about.
 */
const approvedOptions = () => {
  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'LLM_INPUT_CLASSIFIER_ENABLED') return 'true';
      if (key === 'LLM_INPUT_CLASSIFIER_MODEL')
        return 'google/gemini-2.0-flash-lite';
      if (key === 'LLM_ALLOWED_MODELS')
        return 'openai:google/gemini-2.0-flash-lite';
      return undefined;
    }),
  };
  const adapter = {
    providerName: 'openai',
    getDefaultModel: () => 'google/gemini-2.0-flash-lite',
    isRateLimitError: () => false,
  };
  const metrics = {
    incClassifierInput: jest.fn(),
    incClassifierVerdict: jest.fn(),
  };

  return {
    configService,
    adapter,
    metrics,
    options: bindingFor(MESSENGER_AGENT_OPTIONS).useFactory(
      configService,
      { tryFastDefaultReschedule: jest.fn() },
      { resolveDisplayName: jest.fn() },
      metrics,
      {},
      adapter,
      {},
      { cancelForUser: jest.fn() },
      () => Promise.resolve(undefined),
    ),
  };
};

describe('Messenger ChatPipelineModule wiring', () => {
  it('wires reschedule persistence from the owning adapter entrypoint', () => {
    const storeBinding = findFactoryProvider(
      ChatPipelineModule,
      TypeormRescheduleStore,
    );
    const recoveryBinding = findFactoryProvider(
      ChatPipelineModule,
      RescheduleRecoveryCronService,
    );

    expect(storeBinding).toBeDefined();
    expect(recoveryBinding).toBeDefined();

    const store = storeBinding!.useFactory({});
    const recovery = recoveryBinding!.useFactory(
      store,
      { registerCron: jest.fn() },
      {},
      // #1495: the fourth inject entry is the durable attempt store. Passing
      // three arguments left it undefined, and the returned recovery service
      // still had the right type, so nothing noticed.
      { marker: 'attempt-store' },
    );

    expect(store).toBeInstanceOf(TypeormRescheduleStore);
    expect((store as { platform: string }).platform).toBe('messenger');
    expect(recovery).toBeInstanceOf(RescheduleRecoveryCronService);
  });

  it('replays a deferred confirmation through the Messenger transport (#1507)', async () => {
    // The shared binding has no transport, so this spec asserted the shared
    // instance and passed while the override — the one Nest actually resolves —
    // could have been deleted. `findEffectiveFactoryProvider` reads the last
    // binding.
    const binding = findEffectiveFactoryProvider(
      ChatPipelineModule,
      RescheduleRecoveryCronService,
    );
    expect(binding).toBeDefined();

    const sendTextViaPsid = jest.fn().mockResolvedValue('sent');
    const recovery = binding!.useFactory(
      {},
      { registerCron: jest.fn() },
      {},
      {},
      { sendTextViaPsid },
    );

    expect(recovery).toBeInstanceOf(RescheduleRecoveryCronService);
    const notification = (
      recovery as unknown as {
        notification: { deliver: (input: unknown) => Promise<string> };
      }
    ).notification;
    await expect(
      notification.deliver({
        externalId: 'psid-1',
        scheduledTimeLabel: '20/09 lúc 19:00',
        userId: 42,
      }),
    ).resolves.toBe('sent');
    // #1507: without userId the replay charges the PSID bucket and the learner
    // effectively gets two outbound budgets.
    expect(sendTextViaPsid).toHaveBeenCalledWith(
      expect.objectContaining({ psid: 'psid-1', userId: 42 }),
    );
  });

  it('wires PlatformAgentService with LlmContentClassifier in ChatPipelineModule (#864, #868)', () => {
    const { configService, metrics, options } = approvedOptions();

    // The classifier is messenger's own; the shared factory must receive it.
    expect(options).toMatchObject({
      contentClassifier: expect.anything(),
      classifierUsage: {
        provider: 'openai',
        model: 'google/gemini-2.0-flash-lite',
      },
    });

    const agent = bindingFor(PlatformAgentService).useFactory(
      configService,
      {},
      {},
      {},
      {},
      { providerName: 'openai', isRateLimitError: () => false },
      { get: () => undefined },
      options,
      undefined,
    );

    expect(agent).toBeInstanceOf(PlatformAgentService);
    expect(metrics.incClassifierInput).not.toHaveBeenCalled();
  });

  it('fails closed at startup when LLM_INPUT_CLASSIFIER_ENABLED=true with unapproved model (#864, #868)', () => {
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'LLM_INPUT_CLASSIFIER_ENABLED') return 'true';
        if (key === 'LLM_INPUT_CLASSIFIER_MODEL') return 'unapproved-model';
        if (key === 'LLM_ALLOWED_MODELS')
          return 'openai:google/gemini-2.0-flash-lite';
        return undefined;
      }),
    };

    expect(() =>
      bindingFor(MESSENGER_AGENT_OPTIONS).useFactory(
        configService,
        { tryFastDefaultReschedule: jest.fn() },
        { resolveDisplayName: jest.fn() },
        { incClassifierInput: jest.fn() },
        {},
        { providerName: 'openai', isRateLimitError: () => false },
        {},
        { cancelForUser: jest.fn() },
        () => Promise.resolve(undefined),
      ),
    ).toThrow(/not approved by LLM_ALLOWED_MODELS/i);
  });
});
