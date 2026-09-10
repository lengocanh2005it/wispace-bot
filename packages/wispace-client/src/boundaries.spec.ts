import * as adapters from './adapters';
import * as core from './core';

describe('wispace-client package boundaries', () => {
  it('keeps HTTP clients/contracts in core and Nest/Redis wiring in adapters', () => {
    expect(core.UserGoalsApiClient).toBeDefined();
    expect(core.UserCalendarApiClient).toBeDefined();
    expect(core.WispaceDataCache).toBeDefined();
    expect(core.WispaceGoalsService).toBeUndefined();
    expect(core.WispaceCalendarService).toBeUndefined();
    expect(core.WispaceTokenVerifyService).toBeUndefined();
    expect(core.WispaceConfigService).toBeUndefined();
    expect(core.RedisWispaceCacheStore).toBeUndefined();

    expect(adapters.WispaceGoalsService).toBeDefined();
    expect(adapters.WispaceCalendarService).toBeDefined();
    expect(adapters.WispaceTokenVerifyService).toBeDefined();
    expect(adapters.WispaceConfigService).toBeDefined();
    expect(adapters.RedisWispaceCacheStore).toBeDefined();
  });
});
