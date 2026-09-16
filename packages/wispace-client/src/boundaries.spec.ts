import * as adapters from './adapters';
import * as core from './core';

const coreExports = core as Record<string, unknown>;

describe('wispace-client package boundaries', () => {
  it('keeps HTTP clients/contracts in core and Nest/Redis wiring in adapters', () => {
    expect(core.UserGoalsApiClient).toBeDefined();
    expect(core.UserCalendarApiClient).toBeDefined();
    expect(core.WispaceDataCache).toBeDefined();
    expect(coreExports.WispaceGoalsService).toBeUndefined();
    expect(coreExports.WispaceCalendarService).toBeUndefined();
    expect(coreExports.WispaceTokenVerifyService).toBeUndefined();
    expect(coreExports.WispaceConfigService).toBeUndefined();
    expect(coreExports.RedisWispaceCacheStore).toBeUndefined();

    expect(adapters.WispaceGoalsService).toBeDefined();
    expect(adapters.WispaceCalendarService).toBeDefined();
    expect(adapters.WispaceTokenVerifyService).toBeDefined();
    expect(adapters.WispaceConfigService).toBeDefined();
    expect(adapters.RedisWispaceCacheStore).toBeDefined();
  });
});
