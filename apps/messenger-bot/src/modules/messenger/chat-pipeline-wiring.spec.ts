import { PlatformAgentService } from '@wispace/chat-agent';
import {
  RescheduleRecoveryCronService,
  TypeormRescheduleStore,
} from '@wispace/reschedule-confirm/adapters';
import { ChatPipelineModule } from './chat-pipeline.module';
import {
  findEffectiveFactoryProvider,
  findFactoryProvider,
} from '@wispace/bot-common/testing';

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
    const providers = (Reflect.getMetadata('providers', ChatPipelineModule) ??
      []) as Array<unknown>;
    const binding = providers.find(
      (
        provider,
      ): provider is {
        provide: unknown;
        useFactory: (...args: unknown[]) => unknown;
      } =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === PlatformAgentService &&
        'useFactory' in provider &&
        typeof provider.useFactory === 'function',
    );
    expect(binding).toBeDefined();

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

    const agent = binding!.useFactory(
      configService,
      {},
      {},
      {},
      {},
      adapter,
      {},
      {},
      metrics,
      {},
      {},
      null,
      {},
      {},
      () => Promise.resolve(undefined),
    );
    expect(agent).toBeInstanceOf(PlatformAgentService);
  });

  it('fails closed at startup when LLM_INPUT_CLASSIFIER_ENABLED=true with unapproved model (#864, #868)', () => {
    const providers = (Reflect.getMetadata('providers', ChatPipelineModule) ??
      []) as Array<unknown>;
    const binding = providers.find(
      (
        provider,
      ): provider is {
        provide: unknown;
        useFactory: (...args: unknown[]) => unknown;
      } =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === PlatformAgentService &&
        'useFactory' in provider &&
        typeof provider.useFactory === 'function',
    );
    expect(binding).toBeDefined();

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
      binding!.useFactory(
        configService,
        {},
        {},
        {},
        {},
        { providerName: 'openai', isRateLimitError: () => false },
        {},
        {},
        {},
        {},
        {},
        null,
        {},
        {},
        () => Promise.resolve(undefined),
      ),
    ).toThrow(/not approved by LLM_ALLOWED_MODELS/i);
  });
});
