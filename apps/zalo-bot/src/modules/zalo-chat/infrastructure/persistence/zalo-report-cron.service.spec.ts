import { Repository } from 'typeorm';
import { WispaceApiError } from '@wispace/wispace-client';
import { PlatformStudentReportService } from '@wispace/student-report';
import {
  ReportClaimRepositoryPort,
  todayReportDate,
} from '@wispace/scheduler-core';
import { ZaloAccountLinkEntity } from '@zalo/infrastructure/database/entities/zalo-account-link.entity';
import {
  ZaloOutboundService,
  ZaloSendError,
} from '../../application/services/zalo-outbound.service';
import { ZaloReportCronService } from './zalo-report-cron.service';

const reportDate = todayReportDate();
const link = {
  externalUserId: 'zalo-1',
  userId: 42,
  platform: 'zalo',
} as unknown as ZaloAccountLinkEntity;

function buildService(overrides: {
  hasAnyPlatformSentReportToday?: jest.Mock;
  tryClaimScheduledReport?: jest.Mock;
  markScheduledReportClaimSent?: jest.Mock;
  releaseScheduledReportClaim?: jest.Mock;
  sendText?: jest.Mock;
  generateReport?: jest.Mock;
}) {
  const linkRepo = {
    find: jest.fn().mockResolvedValue([link]),
  } as unknown as Repository<ZaloAccountLinkEntity>;
  const hasAnyPlatformSentReportToday =
    overrides.hasAnyPlatformSentReportToday ??
    jest.fn().mockResolvedValue(false);
  const tryClaimScheduledReport =
    overrides.tryClaimScheduledReport ?? jest.fn().mockResolvedValue(true);
  const markScheduledReportClaimSent =
    overrides.markScheduledReportClaimSent ??
    jest.fn().mockResolvedValue(undefined);
  const releaseScheduledReportClaim =
    overrides.releaseScheduledReportClaim ??
    jest.fn().mockResolvedValue(undefined);
  const claimRepo = {
    hasAnyPlatformSentReportToday,
    tryClaimScheduledReport,
    markScheduledReportClaimSent,
    releaseScheduledReportClaim,
  } as unknown as ReportClaimRepositoryPort;
  const sendText = overrides.sendText ?? jest.fn().mockResolvedValue(undefined);
  const outbound = { sendText } as unknown as ZaloOutboundService;
  const generateReport =
    overrides.generateReport ?? jest.fn().mockResolvedValue('report');
  const reportService = {
    generateReport,
  } as unknown as PlatformStudentReportService;
  const service = new ZaloReportCronService(
    linkRepo,
    claimRepo,
    outbound,
    reportService,
  );
  return {
    service,
    hasAnyPlatformSentReportToday,
    tryClaimScheduledReport,
    markScheduledReportClaimSent,
    releaseScheduledReportClaim,
    sendText,
    generateReport,
  };
}

describe('ZaloReportCronService', () => {
  it('skips without sending or claiming when user already sent on another platform', async () => {
    const {
      service,
      hasAnyPlatformSentReportToday,
      tryClaimScheduledReport,
      markScheduledReportClaimSent,
      sendText,
      generateReport,
    } = buildService({
      hasAnyPlatformSentReportToday: jest.fn().mockResolvedValue(true),
    });

    await service.sendDailyReports();

    expect(hasAnyPlatformSentReportToday).toHaveBeenCalledWith(42, reportDate);
    expect(generateReport).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(tryClaimScheduledReport).not.toHaveBeenCalled();
    expect(markScheduledReportClaimSent).not.toHaveBeenCalled();
  });

  it('skips without sending when another instance already claimed', async () => {
    const tryClaimScheduledReport = jest.fn().mockResolvedValue(false);
    const { service, markScheduledReportClaimSent, sendText, generateReport } =
      buildService({ tryClaimScheduledReport });

    await service.sendDailyReports();

    expect(tryClaimScheduledReport).toHaveBeenCalledWith({
      externalUserId: 'zalo-1',
      userId: 42,
      reportDate,
    });
    expect(generateReport).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(markScheduledReportClaimSent).not.toHaveBeenCalled();
  });

  it('claims, sends, marks sent and returns sent on happy path', async () => {
    const {
      service,
      tryClaimScheduledReport,
      markScheduledReportClaimSent,
      sendText,
      generateReport,
    } = buildService({});

    await service.sendDailyReports();

    expect(tryClaimScheduledReport).toHaveBeenCalledWith({
      externalUserId: 'zalo-1',
      userId: 42,
      reportDate,
    });
    expect(generateReport).toHaveBeenCalledWith('zalo-1');
    expect(sendText).toHaveBeenCalledWith('zalo-1', 'report');
    expect(markScheduledReportClaimSent).toHaveBeenCalledWith({
      externalUserId: 'zalo-1',
      reportDate,
    });
  });

  it('releases the claim and skips when send fails with 48h window error', async () => {
    const sendText = jest
      .fn()
      .mockRejectedValue(
        new ZaloSendError(
          'outside consultation window',
          400,
          'Bad Request',
          '{"error":4021}',
        ),
      );
    const releaseScheduledReportClaim = jest.fn().mockResolvedValue(undefined);
    const { service, markScheduledReportClaimSent } = buildService({
      sendText,
      releaseScheduledReportClaim,
    });

    await service.sendDailyReports();

    expect(releaseScheduledReportClaim).toHaveBeenCalledWith({
      externalUserId: 'zalo-1',
      reportDate,
    });
    expect(markScheduledReportClaimSent).not.toHaveBeenCalled();
  });

  it('releases the claim and returns error on generic send failure', async () => {
    const sendText = jest.fn().mockRejectedValue(new Error('boom'));
    const releaseScheduledReportClaim = jest.fn().mockResolvedValue(undefined);
    const { service, markScheduledReportClaimSent } = buildService({
      sendText,
      releaseScheduledReportClaim,
    });

    await service.sendDailyReports();

    expect(releaseScheduledReportClaim).toHaveBeenCalledWith({
      externalUserId: 'zalo-1',
      reportDate,
    });
    expect(markScheduledReportClaimSent).not.toHaveBeenCalled();
  });

  it('releases the claim and skips on WispaceApiError 401', async () => {
    const generateReport = jest
      .fn()
      .mockRejectedValue(
        new WispaceApiError('access denied', 401, 'zalo-1', 'goals'),
      );
    const releaseScheduledReportClaim = jest.fn().mockResolvedValue(undefined);
    const { service, markScheduledReportClaimSent, sendText } = buildService({
      generateReport,
      releaseScheduledReportClaim,
    });

    await service.sendDailyReports();

    expect(sendText).not.toHaveBeenCalled();
    expect(releaseScheduledReportClaim).toHaveBeenCalledWith({
      externalUserId: 'zalo-1',
      reportDate,
    });
    expect(markScheduledReportClaimSent).not.toHaveBeenCalled();
  });
});
