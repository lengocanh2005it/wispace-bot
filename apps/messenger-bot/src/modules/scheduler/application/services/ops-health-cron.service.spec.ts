import { OpsHealthCronService } from './ops-health-cron.service';

describe('OpsHealthCronService', () => {
  it('does not register a heartbeat when the alert cron is disabled', async () => {
    const opsHealthService = {
      isAlertCronEnabled: jest.fn().mockReturnValue(false),
      logSnapshotIfNeeded: jest.fn(),
    };
    const metrics = { registerCron: jest.fn() };
    const service = new OpsHealthCronService(
      opsHealthService as never,
      metrics as never,
    );

    await service.handleDailyOpsHealthCron();

    expect(metrics.registerCron).not.toHaveBeenCalled();
    expect(opsHealthService.logSnapshotIfNeeded).not.toHaveBeenCalled();
  });

  it('registers and completes an enabled heartbeat', async () => {
    const opsHealthService = {
      isAlertCronEnabled: jest.fn().mockReturnValue(true),
      logSnapshotIfNeeded: jest.fn().mockResolvedValue(undefined),
    };
    const metrics = {
      registerCron: jest.fn(),
      recordCronSuccess: jest.fn(),
    };
    const service = new OpsHealthCronService(
      opsHealthService as never,
      metrics as never,
    );

    await service.handleDailyOpsHealthCron();

    expect(metrics.registerCron).toHaveBeenCalledWith(
      'ops-health-daily',
      24 * 60 * 60 * 1000,
    );
    expect(metrics.recordCronSuccess).toHaveBeenCalledWith('ops-health-daily');
  });
});
