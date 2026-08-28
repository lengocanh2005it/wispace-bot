import { DiscordReportOrchestrationService } from './discord-report-orchestration.service';

const MAPPING = {
  id: '1',
  platform: 'discord',
  externalUserId: 'discord-1',
  userId: 10,
  notificationCadence: 'daily',
  status: 'ACTIVE',
};

describe('DiscordReportOrchestrationService', () => {
  it('passes generateReport callback to shared orchestration', async () => {
    const reportService = {
      generateReport: jest.fn().mockResolvedValue('report text'),
    };

    const orchestration = {
      claimAndSend: jest.fn().mockResolvedValue({
        sent: 1,
        skipped: 0,
        deferred: 0,
        windowClosed: 0,
        claimSkipped: 0,
        retryQueued: 0,
        failures: [],
      }),
    };

    const service = new DiscordReportOrchestrationService(
      orchestration as never,
      reportService as never,
    );

    const result = await service.claimAndSend(MAPPING, {
      reportDate: '2026-08-07',
      skipAlreadySentToday: true,
      examDateForOutbox: '2026-08-20',
    });

    expect(result.sent).toBe(1);
    // Generation should NOT be called directly — it goes through the callback
    expect(reportService.generateReport).not.toHaveBeenCalled();
    expect(orchestration.claimAndSend).toHaveBeenCalledWith(MAPPING, {
      reportDate: '2026-08-07',
      skipAlreadySentToday: true,
      reportText: '',
      examDateForOutbox: '2026-08-20',
      classifyError: expect.any(Function),
      generateReport: expect.any(Function),
    });

    // Verify the callback invokes generateReport when called
    const callArgs = orchestration.claimAndSend.mock.calls[0];
    const callback = callArgs[1].generateReport;
    const text = await callback();
    expect(text).toBe('report text');
    expect(reportService.generateReport).toHaveBeenCalledWith('discord-1');
  });

  it('propagates generation errors through the callback', async () => {
    const reportService = {
      generateReport: jest.fn().mockRejectedValue(new Error('gen failed')),
    };

    const orchestration = {
      claimAndSend: jest.fn().mockResolvedValue({
        sent: 0,
        skipped: 0,
        deferred: 1,
        windowClosed: 0,
        claimSkipped: 0,
        retryQueued: 1,
        failures: [],
      }),
    };

    const service = new DiscordReportOrchestrationService(
      orchestration as never,
      reportService as never,
    );

    const result = await service.claimAndSend(MAPPING, {
      reportDate: '2026-08-07',
      skipAlreadySentToday: true,
    });

    // The callback is passed to shared orchestration — errors are handled there
    expect(result.retryQueued).toBe(1);
    expect(orchestration.claimAndSend).toHaveBeenCalledWith(MAPPING, {
      reportDate: '2026-08-07',
      skipAlreadySentToday: true,
      reportText: '',
      classifyError: expect.any(Function),
      generateReport: expect.any(Function),
    });
  });
});
