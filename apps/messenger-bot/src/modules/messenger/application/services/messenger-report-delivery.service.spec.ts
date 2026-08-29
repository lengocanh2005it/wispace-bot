import { MessengerReportDeliveryService } from './messenger-report-delivery.service';
import { ProactiveMessenger24hSkippedError } from '../utils/proactive-send.utils';
import type { RetryableApiError } from '@messenger/modules/student-report/domain/errors/wispace-api.error';
import { StudentReportRetryableError } from '@messenger/modules/student-report/domain/errors/wispace-api.error';

describe('MessengerReportDeliveryService', () => {
  const buildService = (overrides?: {
    generateReport?: jest.Mock;
    sendTextBubblesViaPsid?: jest.Mock;
    sendTextViaPsid?: jest.Mock;
    findActiveMappingByPsid?: jest.Mock;
    upsertPocSubscription?: jest.Mock;
    mappingService?: { linkFromContext: jest.Mock };
  }) => {
    const studentReportService = {
      generateReport: overrides?.generateReport ?? jest.fn(),
    };

    const outbound = {
      sendTextBubblesViaPsid:
        overrides?.sendTextBubblesViaPsid ?? jest.fn().mockResolvedValue(1),
      sendTextViaPsid:
        overrides?.sendTextViaPsid ?? jest.fn().mockResolvedValue(undefined),
    };

    const repository = {
      findActiveMappingByPsid:
        overrides?.findActiveMappingByPsid ??
        jest.fn().mockResolvedValue({ psid: 'psid-1', userId: 10 }),
      upsertPocSubscription:
        overrides?.upsertPocSubscription ??
        jest.fn().mockResolvedValue(undefined),
    };

    const configService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'CHAT_MAX_BUBBLES') return '4';
        if (key === 'CHAT_BUBBLE_MAX_CHARS') return '640';
        return undefined;
      }),
    };

    const mappingService = overrides?.mappingService ?? {
      linkFromContext: jest.fn().mockResolvedValue({ blocked: false }),
    };

    const service = new MessengerReportDeliveryService(
      configService as never,
      repository as never,
      outbound as never,
      studentReportService as never,
      mappingService as never,
    );

    return {
      service,
      studentReportService,
      outbound,
      repository,
      configService,
    };
  };

  describe('sendReportForMapping', () => {
    it('generates report and sends as bubbles', async () => {
      const { service, studentReportService, outbound } = buildService();
      studentReportService.generateReport.mockResolvedValue('Report content');

      const result = await service.sendReportForMapping({
        id: 1,
        psid: 'psid-1',
        userId: 10,
        notificationMessagesToken: 'tok-1',
        topic: 'ielts',
        cadence: 'weekly' as const,
        status: 'ACTIVE' as const,
      });

      expect(result).toBe('Report content');
      expect(studentReportService.generateReport).toHaveBeenCalledWith(
        'psid-1',
      );
      expect(outbound.sendTextBubblesViaPsid).toHaveBeenCalledWith(
        expect.objectContaining({
          psid: 'psid-1',
          userId: 10,
          text: 'Report content',
          messageType: 'SCHEDULED_LEARNING_REPORT',
        }),
      );
    });

    it('throws InternalServerErrorException if mapping has no PSID', async () => {
      const { service } = buildService();

      await expect(
        service.sendReportForMapping({
          id: 1,
          psid: undefined,
          userId: 10,
          notificationMessagesToken: 'tok-1',
          topic: 'ielts',
          cadence: 'weekly' as const,
          status: 'ACTIVE' as const,
        }),
      ).rejects.toThrow('has no PSID');
    });

    it('returns empty string on 24h window error', async () => {
      const { service, studentReportService } = buildService();
      studentReportService.generateReport.mockRejectedValue(
        new ProactiveMessenger24hSkippedError('psid-1', 'REPORT'),
      );

      const result = await service.sendReportForMapping({
        id: 1,
        psid: 'psid-1',
        userId: 10,
        notificationMessagesToken: 'tok-1',
        topic: 'ielts',
        cadence: 'weekly' as const,
        status: 'ACTIVE' as const,
      });

      expect(result).toBe('');
    });

    it('re-throws StudentReportRetryableError', async () => {
      const { service, studentReportService } = buildService();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const cause = new Error('API error') as RetryableApiError;
      Object.defineProperty(cause, 'statusCode', { value: 502 });
      Object.defineProperty(cause, 'endpoint', { value: '/api/scores' });
      Object.defineProperty(cause, 'isRetryable', { value: () => true });
      studentReportService.generateReport.mockRejectedValue(
        new StudentReportRetryableError('psid-1', cause),
      );

      await expect(
        service.sendReportForMapping({
          id: 1,
          psid: 'psid-1',
          userId: 10,
          notificationMessagesToken: 'tok-1',
          topic: 'ielts',
          cadence: 'weekly' as const,
          status: 'ACTIVE' as const,
        }),
      ).rejects.toThrow(StudentReportRetryableError);
    });
  });

  describe('sendReport', () => {
    it('generates report and sends as bubbles', async () => {
      const { service, studentReportService, outbound } = buildService();
      studentReportService.generateReport.mockResolvedValue('Progress report');

      const result = await service.sendReport('psid-1', 10);

      expect(result).toBe('Progress report');
      expect(studentReportService.generateReport).toHaveBeenCalledWith(
        'psid-1',
      );
      expect(outbound.sendTextBubblesViaPsid).toHaveBeenCalledWith(
        expect.objectContaining({
          psid: 'psid-1',
          userId: 10,
          text: 'Progress report',
          messageType: 'LEARNING_PROGRESS',
        }),
      );
    });

    it('sends retry message on StudentReportRetryableError', async () => {
      const { service, studentReportService, outbound } = buildService();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const cause = new Error('API error') as RetryableApiError;
      Object.defineProperty(cause, 'statusCode', { value: 502 });
      Object.defineProperty(cause, 'endpoint', { value: '/api/scores' });
      Object.defineProperty(cause, 'isRetryable', { value: () => true });
      studentReportService.generateReport.mockRejectedValue(
        new StudentReportRetryableError('psid-1', cause),
      );

      const result = await service.sendReport('psid-1', 10);

      expect(result).toContain('thử lại');
      expect(outbound.sendTextBubblesViaPsid).toHaveBeenCalledWith(
        expect.objectContaining({
          messageType: 'LEARNING_PROGRESS_API_DEFERRED',
        }),
      );
    });

    it('returns empty string on 24h window error', async () => {
      const { service, studentReportService } = buildService();
      studentReportService.generateReport.mockRejectedValue(
        new ProactiveMessenger24hSkippedError('psid-1', 'REPORT'),
      );

      const result = await service.sendReport('psid-1', 10);

      expect(result).toBe('');
    });
  });

  describe('registerForScheduledReports', () => {
    it('sends already-subscribed message if cadence and topic match', async () => {
      const { service, repository, outbound } = buildService();
      repository.findActiveMappingByPsid.mockResolvedValue({
        psid: 'psid-1',
        userId: 10,
        cadence: 'weekly',
        topic: 'ielts',
      });

      await service.registerForScheduledReports('psid-1', {
        ref: 'ref-1',
        topic: 'ielts',
        cadence: 'weekly',
        userId: 10,
      });

      expect(outbound.sendTextViaPsid).toHaveBeenCalledWith(
        expect.objectContaining({
          psid: 'psid-1',
          messageType: 'SUBSCRIPTION_ALREADY_ACTIVE',
        }),
      );
      expect(repository.upsertPocSubscription).not.toHaveBeenCalled();
    });

    it('upserts subscription and sends confirmation', async () => {
      const { service, repository, outbound } = buildService();
      repository.findActiveMappingByPsid.mockResolvedValue(null);

      await service.registerForScheduledReports('psid-1', {
        ref: 'ref-1',
        topic: 'ielts',
        cadence: 'weekly',
        userId: 10,
      });

      expect(outbound.sendTextViaPsid).toHaveBeenCalledWith(
        expect.objectContaining({
          psid: 'psid-1',
          messageType: 'SUBSCRIPTION_CONFIRMATION',
        }),
      );
    });

    it('blocks a relink attempt through the mapping service when userId differs (#383)', async () => {
      const mappingService = {
        linkFromContext: jest.fn().mockResolvedValue({ blocked: true }),
      };
      const { service, repository } = buildService({
        mappingService,
      });

      await service.registerForScheduledReports('psid-1', {
        ref: 'ref-1',
        topic: 'ielts',
        cadence: 'weekly',
        userId: 99,
      });

      expect(mappingService.linkFromContext).toHaveBeenCalledWith(
        'psid-1',
        expect.objectContaining({ userId: 99 }),
        { notifyUser: false, syncStudyReminders: false },
      );
      expect(repository.upsertPocSubscription).not.toHaveBeenCalled();
    });
  });
});
