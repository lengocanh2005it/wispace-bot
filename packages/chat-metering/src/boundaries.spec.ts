import * as adapters from './adapters';
import * as core from './core';

const coreExports = core as Record<string, unknown>;

describe('chat-metering package boundaries', () => {
  it('keeps policy/contracts in core and persistence/wiring in adapters', () => {
    expect(core.ChatRateLimitCore).toBeDefined();
    expect(core.MemoryBurstCounter).toBeDefined();
    expect(core.LlmUsageRecorderCore).toBeDefined();
    expect(core.LlmSafetyCore).toBeDefined();
    expect(core.WriteToolBudgetCore).toBeDefined();
    expect(coreExports.ChatMeteringModule).toBeUndefined();
    expect(coreExports.LlmSafetyEventRepository).toBeUndefined();
    expect(coreExports.RedisBurstCounter).toBeUndefined();

    expect(adapters.ChatMeteringModule).toBeDefined();
    expect(adapters.LlmSafetyEventRepository).toBeDefined();
    expect(adapters.RedisBurstCounter).toBeDefined();
  });
});
