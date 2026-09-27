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

  it('keeps the failure-origin classifiers on the core surface', () => {
    // Their location moved out of the package root; their published names did not.
    // Without this, a dropped re-export is caught only by whichever consumer
    // happens to import the name. #1438 changes these names — update in that change.
    expect(core.isOpenAiRateLimitError).toBeDefined();
    expect(core.isOpenAiServerError).toBeDefined();
  });
});
