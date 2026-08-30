import { ReportSendOrchestrationService } from './report-send-orchestration.service';
import { StudentReportRetryableError } from '@messenger/modules/student-report/domain/errors/wispace-api.error';
import { ProactiveMessenger24hSkippedError } from '@messenger/modules/messenger/application/utils/proactive-send.utils';
import {
  MessengerApiError,
  MessengerPartialSendError,
} from '@messenger/modules/messenger/application/services/messenger-outbound.service';

describe('ReportSendOrchestrationService.claimAndSend', () => {
  const mapping = {
    id: 1,
    psid: 'psid-1',
    userId: 10,
    notificationMessagesToken: 'tok-1',
    topic: 'ielts',
    cadence: 'weekly' as const,
    status: 'ACTIVE' as const,
  };

  const buildService = (overrides?: {
    alreadySent?: boolean;
    claimOk?: boolean;
    sendResult?: string | null;
    sendError?: Error;
  }) => {
    const messengerRepository = {
      hasSentScheduledReportToday: jest
        .fn()
        .mockResolvedValue(overrides?.alreadySent ?? false),
      tryClaimScheduledReport: jest
        .fn()
        .mockResolvedValue(
          overrides?.claimOk === false
            ? { claimed: false }
            : { claimed: true, leaseToken: 'lease-1' },
        ),
      markScheduledReportClaimSent: jest.fn().mockResolvedValue(undefined),
      releaseScheduledReportClaim: jest.fn().mockResolvedValue(undefined),
    };

    const messengerReportDeliveryService = {
      sendReportForMapping: overrides?.sendError
        ? jest.fn().mockRejectedValue(overrides.sendError)
        : jest
            .fn()
            .mockResolvedValue(
              overrides?.sendResult !== undefined
                ? overrides.sendResult
                : 'report text',
            ),
    };

    const reportSendJobRepository = {
      markSentByExternalUserExamDate: jest.fn().mockResolvedValue(undefined),
      recordRetryableFailure: jest
        .fn()
        .mockResolvedValue({ nextRetryAt: new Date() }),
    };

    const reportSendScheduleService = {
      getOutboxSettings: jest.fn().mockReturnValue({
        maxRetries: 3,
        retryBackoffMinutes: 15,
      }),
    };

    const service = new ReportSendOrchestrationService(
      messengerRepository as never,
      messengerReportDeliveryService as never,
      reportSendJobRepository as never,
      reportSendScheduleService as never,
      { get: jest.fn() } as never,
    );

    return {
      service,
      messengerRepository,
      messengerReportDeliveryService,
      reportSendJobRepository,
    };
  };

  it('happy path: claim → send → mark sent', async () => {
    const { service, messengerRepository, messengerReportDeliveryService } =
      buildService({ sendResult: 'report text' });

    const result = await service.claimAndSend(mapping, {
      reportDate: '2026-07-11',
      skipAlreadySentToday: true,
      examDateForOutbox: '2026-07-15',
    });

    expect(result.sent).toBe(1);
    expect(result.skipped).toBe(0);
    expect(
      messengerReportDeliveryService.sendReportForMapping,
    ).toHaveBeenCalledWith(mapping);
    expect(messengerRepository.tryClaimScheduledReport).toHaveBeenCalledWith(
      {
        externalUserId: 'psid-1',
        userId: 10,
        reportDate: '2026-07-11',
      },
      expect.any(Number),
    );
    expect(
      messengerRepository.markScheduledReportClaimSent,
    ).toHaveBeenCalledWith(
      {
        externalUserId: 'psid-1',
        reportDate: '2026-07-11',
      },
      'lease-1',
      'sent',
      'messenger-report:psid-1:2026-07-11',
    );
  });

  it('already sent today → skip', async () => {
    const { service, messengerReportDeliveryService } = buildService({
      alreadySent: true,
    });

    const result = await service.claimAndSend(mapping, {
      reportDate: '2026-07-11',
      skipAlreadySentToday: true,
      examDateForOutbox: '2026-07-15',
    });

    expect(result.skipped).toBe(1);
    expect(result.sent).toBe(0);
    expect(
      messengerReportDeliveryService.sendReportForMapping,
    ).not.toHaveBeenCalled();
  });

  it('claim fails (R4 idempotency) → skip', async () => {
    const { service, messengerReportDeliveryService } = buildService({
      claimOk: false,
    });

    const result = await service.claimAndSend(mapping, {
      reportDate: '2026-07-11',
      skipAlreadySentToday: true,
    });

    expect(result.claimSkipped).toBe(1);
    expect(result.sent).toBe(0);
    expect(
      messengerReportDeliveryService.sendReportForMapping,
    ).not.toHaveBeenCalled();
  });

  it('send returns null (24h window closed) → release claim', async () => {
    const { service, messengerRepository } = buildService({
      sendResult: null,
    });

    const result = await service.claimAndSend(mapping, {
      reportDate: '2026-07-11',
      skipAlreadySentToday: true,
    });

    expect(result.windowClosed).toBe(1);
    expect(result.sent).toBe(0);
    expect(
      messengerRepository.releaseScheduledReportClaim,
    ).toHaveBeenCalledWith(
      {
        externalUserId: 'psid-1',
        reportDate: '2026-07-11',
      },
      'lease-1',
    );
  });

  it('StudentReportRetryableError → release claim, record outbox', async () => {
    const { service, messengerRepository, reportSendJobRepository } =
      buildService({
        sendError: new StudentReportRetryableError(
          'psid-1',
          new Error('timeout'),
        ),
      });

    const result = await service.claimAndSend(mapping, {
      reportDate: '2026-07-11',
      skipAlreadySentToday: true,
      examDateForOutbox: '2026-07-15',
    });

    expect(result.deferred).toBe(1);
    expect(result.retryQueued).toBe(1);
    expect(
      messengerRepository.releaseScheduledReportClaim,
    ).toHaveBeenCalledWith(
      {
        externalUserId: 'psid-1',
        reportDate: '2026-07-11',
      },
      'lease-1',
    );
    expect(reportSendJobRepository.recordRetryableFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        externalUserId: 'psid-1',
        examDate: '2026-07-15',
        maxRetries: 3,
      }),
    );
  });

  it('ProactiveMessenger24hSkippedError → release claim', async () => {
    const { service, messengerRepository } = buildService({
      sendError: new ProactiveMessenger24hSkippedError('psid-1', 'REPORT'),
    });

    const result = await service.claimAndSend(mapping, {
      reportDate: '2026-07-11',
      skipAlreadySentToday: true,
    });

    expect(result.windowClosed).toBe(1);
    expect(result.sent).toBe(0);
    expect(
      messengerRepository.releaseScheduledReportClaim,
    ).toHaveBeenCalledWith(
      {
        externalUserId: 'psid-1',
        reportDate: '2026-07-11',
      },
      'lease-1',
    );
  });

  it('unknown error → release claim, return failure', async () => {
    const { service, messengerRepository } = buildService({
      sendError: new Error('unexpected'),
    });

    const result = await service.claimAndSend(mapping, {
      reportDate: '2026-07-11',
      skipAlreadySentToday: true,
    });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toEqual({
      externalUserId: 'psid-1',
      error: 'unexpected',
    });
    expect(
      messengerRepository.releaseScheduledReportClaim,
    ).toHaveBeenCalledWith(
      {
        externalUserId: 'psid-1',
        reportDate: '2026-07-11',
      },
      'lease-1',
    );
  });

  it('Meta Send API 5xx → release claim + queue R5 outbox job', async () => {
    const { service, messengerRepository, reportSendJobRepository } =
      buildService({
        sendError: new MessengerApiError(
          'Meta down',
          500,
          'Internal Server Error',
          '{"error":{"code":190}}',
        ),
      });

    const result = await service.claimAndSend(mapping, {
      reportDate: '2026-07-11',
      skipAlreadySentToday: true,
      examDateForOutbox: '2026-07-15',
    });

    expect(result.deferred).toBe(1);
    expect(result.retryQueued).toBe(1);
    expect(
      messengerRepository.releaseScheduledReportClaim,
    ).toHaveBeenCalledWith(
      {
        externalUserId: 'psid-1',
        reportDate: '2026-07-11',
      },
      'lease-1',
    );
    expect(reportSendJobRepository.recordRetryableFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        externalUserId: 'psid-1',
        examDate: '2026-07-15',
      }),
    );
  });

  it('Meta Send API 4xx → release claim, no outbox job', async () => {
    const { service, messengerRepository, reportSendJobRepository } =
      buildService({
        sendError: new MessengerApiError(
          'Invalid PSID',
          400,
          'Bad Request',
          '{"error":{"code":100}}',
        ),
      });

    const result = await service.claimAndSend(mapping, {
      reportDate: '2026-07-11',
      skipAlreadySentToday: true,
      examDateForOutbox: '2026-07-15',
    });

    expect(result.failures).toHaveLength(1);
    expect(
      reportSendJobRepository.recordRetryableFailure,
    ).not.toHaveBeenCalled();
    expect(
      messengerRepository.releaseScheduledReportClaim,
    ).toHaveBeenCalledWith(
      {
        externalUserId: 'psid-1',
        reportDate: '2026-07-11',
      },
      'lease-1',
    );
  });

  it('Meta Send API timeout → mark claim ambiguous without replay', async () => {
    const { service, messengerRepository, reportSendJobRepository } =
      buildService({
        sendError: new MessengerApiError(
          'Meta timeout',
          408,
          'Request Timeout',
          '',
        ),
      });

    const result = await service.claimAndSend(mapping, {
      reportDate: '2026-07-11',
      skipAlreadySentToday: true,
      examDateForOutbox: '2026-07-15',
    });

    expect(result.sent).toBe(1);
    expect(result.deferred).toBe(0);
    expect(
      reportSendJobRepository.recordRetryableFailure,
    ).not.toHaveBeenCalled();
    expect(
      messengerRepository.releaseScheduledReportClaim,
    ).not.toHaveBeenCalled();
    expect(
      messengerRepository.markScheduledReportClaimSent,
    ).toHaveBeenCalledWith(
      {
        externalUserId: 'psid-1',
        reportDate: '2026-07-11',
      },
      'lease-1',
      'sent',
      'messenger-report:psid-1:2026-07-11',
      'ambiguous',
    );
  });

  it('partial bubble send → mark sent, no re-send, no release', async () => {
    const { service, messengerRepository, reportSendJobRepository } =
      buildService({
        sendError: new MessengerPartialSendError(
          2,
          new MessengerApiError(
            'bubble 3 failed',
            500,
            'Internal Server Error',
            '{}',
          ),
        ),
      });

    const result = await service.claimAndSend(mapping, {
      reportDate: '2026-07-11',
      skipAlreadySentToday: true,
      examDateForOutbox: '2026-07-15',
    });

    expect(result.sent).toBe(1);
    expect(
      messengerRepository.markScheduledReportClaimSent,
    ).toHaveBeenCalledWith(
      {
        externalUserId: 'psid-1',
        reportDate: '2026-07-11',
      },
      'lease-1',
      'sent',
      'messenger-report:psid-1:2026-07-11',
    );
    expect(
      messengerRepository.releaseScheduledReportClaim,
    ).not.toHaveBeenCalled();
    expect(
      reportSendJobRepository.recordRetryableFailure,
    ).not.toHaveBeenCalled();
  });
});
