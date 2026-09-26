import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { SchedulerController } from '@messenger/modules/scheduler/presentation/controllers/scheduler.controller';
import { ReportCronService } from '@messenger/modules/scheduler/application/services/report-cron.service';
import { StudyReminderSyncService } from '@wispace/study-reminder-shared/adapters';
import { StudyReminderWorkerService } from '@wispace/study-reminder-shared/adapters';
import { StudySessionSourceService } from '@messenger/modules/study-reminder/application/services/study-session-source.service';
import { MessengerMappingService } from '@messenger/modules/messenger/application/services/messenger-mapping.service';
import { ReportSendRetryDispatchService } from '@messenger/modules/scheduler/application/services/report-send-retry-dispatch.service';
import { PrivacyDataService } from '@wispace/database';
import { PRIVACY_DATA } from '@messenger/modules/messenger/application/chat-processing-seams.port';
import { AgentReplyAdapter } from '@messenger/modules/messenger/infrastructure/adapters/agent-reply.adapter';
import { AGENT_REPLY } from '@messenger/modules/messenger/application/ports/agent-reply.port';
import { PlatformChatHistoryService } from '@wispace/chat-agent';
import { MessengerChatEnqueueService } from '@messenger/modules/messenger/application/services/messenger-chat-enqueue.service';
import { RedisUserDisplayNameCache } from '@wispace/bot-common/redis';
import { createContractApp } from './helpers';

/** Minimal mocks for SchedulerController — only what the DI container needs. */
function buildControllerProviders() {
  const noop = jest.fn();
  // The controller injects the PRIVACY_DATA / AGENT_REPLY tokens, not the
  // concrete classes, so each mock is registered under both keys.
  const privacyData = {
    unlink: jest.fn().mockResolvedValue({
      unlinked: true,
      status: 'complete',
    }),
    delete: jest.fn().mockResolvedValue({
      deleted: true,
      status: 'complete',
      outstandingStores: [],
    }),
    export: jest.fn().mockResolvedValue({ data: {} }),
  };
  const agentReply = { clearClarificationState: noop };
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
    { provide: PrivacyDataService, useValue: privacyData },
    { provide: PRIVACY_DATA, useValue: privacyData },
    { provide: AgentReplyAdapter, useValue: agentReply },
    { provide: AGENT_REPLY, useValue: agentReply },
    { provide: PlatformChatHistoryService, useValue: { clear: noop } },
    { provide: MessengerChatEnqueueService, useValue: { clear: noop } },
    {
      provide: RedisUserDisplayNameCache,
      useValue: { del: noop, delStrict: noop },
    },
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
          expect(body).toEqual({ unlinked: true, status: 'complete' });
        });

      expect(privacyService.unlink).toHaveBeenCalledWith(
        'messenger',
        'psid-123',
        expect.any(Object),
        undefined,
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

    it('rejects a malformed expected mapping fence', async () => {
      await request(app.getHttpServer())
        .post('/v1/messenger/privacy/unlink')
        .send({
          externalUserId: 'psid-123',
          expectedMapping: { exists: 'yes' },
        })
        .expect(400);
    });

    it('returns 202 and canonical outstanding stores when cleanup is incomplete', async () => {
      privacyService.unlink.mockResolvedValueOnce({
        deleted: true,
        unlinked: true,
        status: 'incomplete',
        cleanupId: 'opaque-cleanup-id',
        outstandingStores: ['chat_history'],
      });

      await request(app.getHttpServer())
        .post('/v1/messenger/privacy/unlink')
        .send({ externalUserId: 'psid-123' })
        .expect(202)
        .expect(({ body }) => {
          expect(body).toEqual({
            deleted: true,
            unlinked: true,
            status: 'incomplete',
            cleanupId: 'opaque-cleanup-id',
            outstandingStores: ['chat_history'],
          });
        });
    });

    it('returns 409 for an expected-generation conflict', async () => {
      privacyService.unlink.mockResolvedValueOnce({
        deleted: false,
        unlinked: false,
        conflict: true,
      });

      await request(app.getHttpServer())
        .post('/v1/messenger/privacy/unlink')
        .send({
          externalUserId: 'psid-123',
          expectedMapping: {
            exists: true,
            userId: 42,
            mappingGeneration: '3',
          },
        })
        .expect(409);

      expect(privacyService.unlink).toHaveBeenLastCalledWith(
        'messenger',
        'psid-123',
        expect.any(Object),
        { exists: true, userId: 42, mappingGeneration: '3' },
      );
    });
  });

  describe('POST /v1/messenger/privacy/delete', () => {
    it('calls delete with externalUserId and returns result', async () => {
      await request(app.getHttpServer())
        .post('/v1/messenger/privacy/delete')
        .send({ externalUserId: 'psid-456' })
        .expect(200)
        .expect(({ body }) => {
          expect(body).toEqual({
            deleted: true,
            status: 'complete',
            outstandingStores: [],
          });
        });

      expect(privacyService.delete).toHaveBeenCalledWith(
        'messenger',
        'psid-456',
        expect.any(Object),
        undefined,
      );
    });

    it('rejects body without externalUserId', async () => {
      await request(app.getHttpServer())
        .post('/v1/messenger/privacy/delete')
        .send({})
        .expect(400);
    });

    it('returns 202 for an incomplete delete without changing the mutation boolean', async () => {
      privacyService.delete.mockResolvedValueOnce({
        deleted: false,
        status: 'incomplete',
        cleanupId: 'opaque-delete-id',
        outstandingStores: ['chat_queue'],
      });

      await request(app.getHttpServer())
        .post('/v1/messenger/privacy/delete')
        .send({ externalUserId: 'psid-456' })
        .expect(202)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            deleted: false,
            status: 'incomplete',
            cleanupId: 'opaque-delete-id',
            outstandingStores: ['chat_queue'],
          });
        });
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
