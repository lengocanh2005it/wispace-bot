import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { SchedulerController } from '@messenger/modules/scheduler/presentation/controllers/scheduler.controller';
import { InternalApiKeyGuard } from '@wispace/bot-common/guard';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ReportCronService } from '@messenger/modules/scheduler/application/services/report-cron.service';
import { StudyReminderSyncService } from '@wispace/study-reminder-shared';
import { StudyReminderWorkerService } from '@wispace/study-reminder-shared';
import { StudySessionSourceService } from '@messenger/modules/study-reminder/application/services/study-session-source.service';
import { MessengerMappingService } from '@messenger/modules/messenger/application/services/messenger-mapping.service';
import { ReportSendRetryDispatchService } from '@messenger/modules/scheduler/application/services/report-send-retry-dispatch.service';
import { PrivacyDataService } from '@wispace/database';
import { MessengerAgentService } from '@messenger/modules/messenger/application/agent/messenger-agent.service';
import { PlatformChatHistoryService } from '@wispace/chat-agent';
import { MessengerChatEnqueueService } from '@messenger/modules/messenger/application/services/messenger-chat-enqueue.service';
import { RedisUserDisplayNameCache } from '@wispace/bot-common/redis';

function buildMockDeps() {
  return {
    reportCronService: {
      sendScheduledReports: jest
        .fn()
        .mockResolvedValue({ sent: 1, skipped: 0 }),
    },
    studyReminderSyncService: {
      syncUpcomingSessions: jest.fn().mockResolvedValue({
        synced: 1,
        cancelled: 0,
        created: 1,
        failures: [],
      }),
    },
    studyReminderWorkerService: {
      runSyncAndDispatch: jest.fn().mockResolvedValue({
        sync: { synced: 0, cancelled: 0, created: 0, failures: [] },
        dispatch: { sent: 0, failed: 0, failures: [] },
      }),
      runEveningRollover: jest.fn().mockResolvedValue({
        deletedSent: 0,
        sync: { synced: 0, cancelled: 0, created: 0, failures: [] },
      }),
    },
    sessionSourceService: {},
    messengerMappingService: {
      relinkPsidToUserId: jest.fn().mockResolvedValue({ success: true }),
    },
    reportSendRetryDispatchService: {
      dispatchDueReportRetries: jest.fn().mockResolvedValue({ dispatched: 0 }),
    },
    privacyService: {
      unlink: jest.fn().mockResolvedValue({ unlinked: true }),
      delete: jest.fn().mockResolvedValue({ deleted: true }),
      export: jest.fn().mockResolvedValue({ data: {} }),
    },
    clarificationAgent: { clearClarificationState: jest.fn() },
    historyService: { clear: jest.fn() },
    chatEnqueueService: { clear: jest.fn() },
    displayNameCache: { del: jest.fn() },
  };
}

describe('Messenger privacy endpoints (HTTP contract)', () => {
  let app: INestApplication<App>;
  let deps: ReturnType<typeof buildMockDeps>;

  beforeEach(async () => {
    deps = buildMockDeps();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [SchedulerController],
      providers: [
        { provide: ReportCronService, useValue: deps.reportCronService },
        {
          provide: StudyReminderSyncService,
          useValue: deps.studyReminderSyncService,
        },
        {
          provide: StudyReminderWorkerService,
          useValue: deps.studyReminderWorkerService,
        },
        {
          provide: StudySessionSourceService,
          useValue: deps.sessionSourceService,
        },
        {
          provide: MessengerMappingService,
          useValue: deps.messengerMappingService,
        },
        {
          provide: ReportSendRetryDispatchService,
          useValue: deps.reportSendRetryDispatchService,
        },
        { provide: PrivacyDataService, useValue: deps.privacyService },
        { provide: MessengerAgentService, useValue: deps.clarificationAgent },
        { provide: PlatformChatHistoryService, useValue: deps.historyService },
        {
          provide: MessengerChatEnqueueService,
          useValue: deps.chatEnqueueService,
        },
        { provide: RedisUserDisplayNameCache, useValue: deps.displayNameCache },
      ],
    })
      .overrideGuard(InternalApiKeyGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  describe('POST /messenger/privacy/unlink', () => {
    it('calls unlink with externalUserId and returns result', async () => {
      await request(app.getHttpServer())
        .post('/v1/messenger/privacy/unlink')
        .send({ externalUserId: 'psid-123' })
        .expect(200)
        .expect(({ body }) => {
          expect(body).toEqual({ unlinked: true });
        });

      expect(deps.privacyService.unlink).toHaveBeenCalledWith(
        'messenger',
        'psid-123',
        expect.any(Object),
      );
    });

    it('rejects body without externalUserId', async () => {
      await request(app.getHttpServer())
        .post('/v1/messenger/privacy/unlink')
        .send({})
        .expect(400);
    });

    it('rejects body with wrong type for externalUserId', async () => {
      await request(app.getHttpServer())
        .post('/v1/messenger/privacy/unlink')
        .send({ externalUserId: 12345 })
        .expect(400);
    });
  });

  describe('POST /v1/messenger/privacy/delete', () => {
    it('calls delete with externalUserId and returns result', async () => {
      await request(app.getHttpServer())
        .post('/v1/messenger/privacy/delete')
        .send({ externalUserId: 'psid-456' })
        .expect(200)
        .expect(({ body }) => {
          expect(body).toEqual({ deleted: true });
        });

      expect(deps.privacyService.delete).toHaveBeenCalledWith(
        'messenger',
        'psid-456',
        expect.any(Object),
      );
    });

    it('rejects body without externalUserId', async () => {
      await request(app.getHttpServer())
        .post('/v1/messenger/privacy/delete')
        .send({})
        .expect(400);
    });
  });

  describe('POST /v1/messenger/ops/clarification/clear', () => {
    it('returns 204 no-content on success', async () => {
      await request(app.getHttpServer())
        .post('/v1/messenger/ops/clarification/clear')
        .send({ externalUserId: 'psid-789' })
        .expect(204);
    });
  });
});
