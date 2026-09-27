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
    // Their location moved out of the package root in #1442; #1438 then gave them
    // vendor-neutral names. Without this, a dropped re-export is caught only by
    // whichever consumer happens to import the name.
    expect(core.isRateLimitError).toBeDefined();
    expect(core.isServerError).toBeDefined();
    expect(coreExports.isOpenAiRateLimitError).toBeUndefined();
    expect(coreExports.isOpenAiServerError).toBeUndefined();
  });

  it('publishes no vendor-named export from the core surface', () => {
    // The principle, not just the two names #1438 happened to rename. A rule that
    // only knew `isOpenAi*` would stay green while `isAnthropicRateLimitError`
    // shipped — which is the exact gap #1439 closes, asserted here first.
    const vendorNamedExports = Object.keys(coreExports).filter((name) =>
      /openai|anthropic|gemini/i.test(name),
    );
    expect(vendorNamedExports).toEqual([]);
  });
});
