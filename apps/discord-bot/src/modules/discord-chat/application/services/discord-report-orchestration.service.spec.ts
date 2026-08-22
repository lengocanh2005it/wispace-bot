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
  it('generates report text and delegates to shared orchestration', async () => {
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
    expect(reportService.generateReport).toHaveBeenCalledWith('discord-1');
    expect(orchestration.claimAndSend).toHaveBeenCalledWith(MAPPING, {
      reportDate: '2026-08-07',
      skipAlreadySentToday: true,
      reportText: 'report text',
      examDateForOutbox: '2026-08-20',
      classifyError: expect.any(Function),
    });
  });

  it('returns failure when report generation throws', async () => {
    const reportService = {
      generateReport: jest.fn().mockRejectedValue(new Error('gen failed')),
    };

    const orchestration = { claimAndSend: jest.fn() };

    const service = new DiscordReportOrchestrationService(
      orchestration as never,
      reportService as never,
    );

    const result = await service.claimAndSend(MAPPING, {
      reportDate: '2026-08-07',
      skipAlreadySentToday: true,
    });

    expect(result.sent).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].error).toBe('Error: gen failed');
    expect(orchestration.claimAndSend).not.toHaveBeenCalled();
  });
});
