import { PlatformAgentService } from '@wispace/chat-agent';
import {
  RescheduleRecoveryCronService,
  TypeormRescheduleStore,
} from '@wispace/reschedule-confirm/adapters';
import { ChatPipelineModule } from './chat-pipeline.module';

function findFactoryProvider(module: object, token: unknown) {
  const providers = (Reflect.getMetadata('providers', module) ??
    []) as Array<unknown>;
  return providers.find(
    (
      provider,
    ): provider is {
      provide: unknown;
      useFactory: (...args: unknown[]) => unknown;
    } =>
      typeof provider === 'object' &&
      provider !== null &&
      'provide' in provider &&
      provider.provide === token &&
      'useFactory' in provider &&
      typeof provider.useFactory === 'function',
  );
}

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
    );

    expect(store).toBeInstanceOf(TypeormRescheduleStore);
    expect((store as { platform: string }).platform).toBe('messenger');
    expect(recovery).toBeInstanceOf(RescheduleRecoveryCronService);
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
