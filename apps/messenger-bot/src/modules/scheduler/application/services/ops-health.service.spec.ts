import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ChatQuotaOpsService } from '../../../chat-rate-limit/application/services/chat-quota-ops.service';
import { STUDY_REMINDER_JOB_REPOSITORY } from '../../../study-reminder/domain/repositories/study-reminder-job.repository.port';
import { MESSENGER_MESSAGE_LOG_REPOSITORY } from '../../../messenger/domain/repositories/messenger-message-log.repository.port';
import { LlmSafetyEventService } from '../../../llm-safety/application/services/llm-safety-event.service';
import { OpsHealthService } from './ops-health.service';

describe('OpsHealthService', () => {
  let service: OpsHealthService;

  const chatQuotaOpsService = {
    getSummary: jest.fn(),
  };

  const studyReminderJobRepository = {
    countJobsByStatus: jest.fn(),
    countTerminalFailedSince: jest.fn(),
    countStuckProcessing: jest.fn(),
    findTerminalFailedSince: jest.fn(),
    findStuckProcessing: jest.fn(),
  };

  const messageLogRepository = {
    countMessageLogsByTypeSince: jest.fn(),
  };

  const llmSafetyEventService = {
    countWarnings24h: jest.fn().mockResolvedValue(0),
    readWarningDailyThreshold: jest.fn().mockReturnValue(5),
    isEnabled: jest.fn().mockReturnValue(true),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpsHealthService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              const values: Record<string, string> = {
                OPS_ALERT_FAILED_JOBS_HOURS: '24',
                OPS_ALERT_STUCK_PROCESSING_MINUTES: '10',
                OPS_ALERT_DENY_LOOKBACK_HOURS: '24',
                OPS_ALERT_MIN_FAILED_JOBS: '1',
                OPS_ALERT_MIN_STUCK_RESERVED: '1',
                OPS_ALERT_MIN_STUCK_PROCESSING: '1',
              };
              return values[key];
            },
          },
        },
        {
          provide: ChatQuotaOpsService,
          useValue: chatQuotaOpsService,
        },
        {
          provide: STUDY_REMINDER_JOB_REPOSITORY,
          useValue: studyReminderJobRepository,
        },
        {
          provide: MESSENGER_MESSAGE_LOG_REPOSITORY,
          useValue: messageLogRepository,
        },
        {
          provide: LlmSafetyEventService,
          useValue: llmSafetyEventService,
        },
      ],
    }).compile();

    service = module.get(OpsHealthService);
  });

  it('builds alerts when terminal failed jobs exist (S1)', async () => {
    chatQuotaOpsService.getSummary.mockResolvedValue({
      usageDate: '2026-06-13',
      stuckReserved: 0,
      stuckReservedMs: 600_000,
      denyLogs24h: 0,
      usersAtDailyLimit: 0,
      dailyLimit: 15,
      idempotencyByStatus: {},
      logGrepHints: ['CHAT_QUOTA_DENY'],
    });
    studyReminderJobRepository.countJobsByStatus.mockResolvedValue({
      failed: 2,
    });
    studyReminderJobRepository.countTerminalFailedSince.mockResolvedValue(2);
    studyReminderJobRepository.countStuckProcessing.mockResolvedValue(0);
    studyReminderJobRepository.findTerminalFailedSince.mockResolvedValue([]);
    studyReminderJobRepository.findStuckProcessing.mockResolvedValue([]);
    messageLogRepository.countMessageLogsByTypeSince.mockResolvedValue(0);

    const snapshot = await service.collectSnapshot();

    expect(snapshot.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'STUDY_REMINDER_TERMINAL_FAILED' }),
      ]),
    );
  });

  it('builds alert for stuck reserved idempotency (I1)', async () => {
    chatQuotaOpsService.getSummary.mockResolvedValue({
      usageDate: '2026-06-13',
      stuckReserved: 3,
      stuckReservedMs: 600_000,
      denyLogs24h: 0,
      usersAtDailyLimit: 1,
      dailyLimit: 15,
      idempotencyByStatus: { reserved: 3 },
      logGrepHints: ['CHAT_QUOTA_DENY'],
    });
    studyReminderJobRepository.countJobsByStatus.mockResolvedValue({
      pending: 1,
    });
    studyReminderJobRepository.countTerminalFailedSince.mockResolvedValue(0);
    studyReminderJobRepository.countStuckProcessing.mockResolvedValue(0);
    studyReminderJobRepository.findTerminalFailedSince.mockResolvedValue([]);
    studyReminderJobRepository.findStuckProcessing.mockResolvedValue([]);
    messageLogRepository.countMessageLogsByTypeSince.mockResolvedValue(5);

    const snapshot = await service.collectSnapshot();

    expect(snapshot.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'CHAT_QUOTA_STUCK_RESERVED' }),
      ]),
    );
    expect(snapshot.chatQuota.denyLogs24h).toBe(5);
  });
});
