import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { SchedulerController } from '@messenger/modules/scheduler/presentation/controllers/scheduler.controller';
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
import { createContractApp } from './helpers';

/** Minimal mocks for SchedulerController — only what the DI container needs. */
function buildControllerProviders() {
  const noop = jest.fn();
  return [
    { provide: ReportCronService, useValue: { sendScheduledReports: noop } },
    {
      provide: StudyReminderSyncService,
      useValue: { syncUpcomingSessions: noop },
    },
    {
      provide: StudyReminderWorkerService,
      useValue: { runSyncAndDispatch: noop, runEveningRollover: noop },
    },
    { provide: StudySessionSourceService, useValue: {} },
    {
      provide: MessengerMappingService,
      useValue: { relinkPsidToUserId: noop },
    },
    {
      provide: ReportSendRetryDispatchService,
      useValue: { dispatchDueReportRetries: noop },
    },
    {
      provide: PrivacyDataService,
      useValue: {
        unlink: jest.fn().mockResolvedValue({ unlinked: true }),
        delete: jest.fn().mockResolvedValue({ deleted: true }),
        export: jest.fn().mockResolvedValue({ data: {} }),
      },
    },
    {
      provide: MessengerAgentService,
      useValue: { clearClarificationState: noop },
    },
    { provide: PlatformChatHistoryService, useValue: { clear: noop } },
    { provide: MessengerChatEnqueueService, useValue: { clear: noop } },
    { provide: RedisUserDisplayNameCache, useValue: { del: noop } },
  ];
}

describe('Messenger privacy endpoints (HTTP contract)', () => {
  let app: INestApplication<App>;
  let privacyService: {
    unlink: jest.Mock;
    delete: jest.Mock;
    export: jest.Mock;
  };

  beforeEach(async () => {
    const providers = buildControllerProviders();
    privacyService = providers.find((p) => p.provide === PrivacyDataService)!
      .useValue as typeof privacyService;

    app = await createContractApp({
      controllers: [SchedulerController],
      providers,
    });
  });

  afterEach(async () => {
    await app?.close();
  });

  describe('POST /v1/messenger/privacy/unlink', () => {
    it('calls unlink with externalUserId and returns result', async () => {
      await request(app.getHttpServer())
        .post('/v1/messenger/privacy/unlink')
        .send({ externalUserId: 'psid-123' })
        .expect(200)
        .expect(({ body }) => {
          expect(body).toEqual({ unlinked: true });
        });

      expect(privacyService.unlink).toHaveBeenCalledWith(
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

      expect(privacyService.delete).toHaveBeenCalledWith(
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
