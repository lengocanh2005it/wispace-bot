import * as adapters from './adapters';
import * as core from './core';

const coreExports = core as Record<string, unknown>;

describe('chat-metering package boundaries', () => {
  it('keeps policy/contracts in core and persistence/wiring in adapters', () => {
    expect(core.ChatRateLimitCore).toBeDefined();
    expect(core.LlmUsageRecorderCore).toBeDefined();
    expect(core.LlmSafetyCore).toBeDefined();
    expect(core.WriteToolBudgetCore).toBeDefined();
    expect(coreExports.ChatMeteringModule).toBeUndefined();
    expect(coreExports.LlmSafetyEventRepository).toBeUndefined();
    expect(coreExports.RedisBurstCounter).toBeUndefined();
    // #1288: the memory burst store is retired, so it must not come back
    // through the core surface. Postgres is the correctness floor (ADR-0007).
    expect(coreExports.MemoryBurstCounter).toBeUndefined();

    expect(adapters.ChatMeteringModule).toBeDefined();
    expect(adapters.LlmSafetyEventRepository).toBeDefined();
    expect(adapters.RedisBurstCounter).toBeDefined();
  });
});
