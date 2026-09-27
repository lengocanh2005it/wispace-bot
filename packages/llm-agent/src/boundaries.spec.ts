import * as adapters from './adapters';
import * as core from './core';

const coreExports = core as Record<string, unknown>;
const adapterExports = adapters as Record<string, unknown>;

describe('llm-agent package boundaries', () => {
  it('keeps orchestration in core and runtime wiring in adapters', () => {
    expect(core.LlmAgentService).toBeDefined();
    expect(core.BoundedAdmissionQueue).toBeDefined();
    expect(coreExports.PrivacyStateService).toBeUndefined();
    expect(coreExports.detectPrivacyIntent).toBeUndefined();
    expect(coreExports.isConfirmationResponse).toBeUndefined();
    expect(coreExports.isCancellationResponse).toBeUndefined();
    expect(coreExports.createLlmProviderAdapterFromEnv).toBeUndefined();

    expect(adapterExports.PrivacyStateService).toBeUndefined();
    expect(adapters.createLlmProviderAdapterFromEnv).toBeDefined();
    expect(adapters.createEnvLlmExecutionPort).toBeDefined();
  });

  it('keeps the upstream-failure classifiers on the core surface', () => {
    // The classifiers moved out of the package root, but their published names did
    // not change. Asserting it here states it as a property of the package; without
    // this the only thing catching a dropped re-export is whichever consumer
    // happens to import the name, which is a fact about who imports what. The names
    // are vendor-specific and #1438 changes them, so update this in the same change.
    expect(core.isOpenAiRateLimitError).toBeDefined();
    expect(core.isOpenAiServerError).toBeDefined();
  });
});
