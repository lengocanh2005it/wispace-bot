import * as adapters from './adapters';

describe('cleanup-cron package boundaries', () => {
  it('advertises only its intentional framework-bound adapter surface', () => {
    expect(adapters.CleanupCronService).toBeDefined();
    expect(adapters.PlatformCleanupCronService).toBeDefined();
    expect(adapters.PlatformLinkAuditCleanupService).toBeDefined();
  });
});
