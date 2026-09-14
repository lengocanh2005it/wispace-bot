import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ThrottlerGuard } from '@nestjs/throttler';
import { InternalApiKeyGuard } from '@wispace/bot-common/guard';
import { BotMetricsService } from '@wispace/bot-metrics';
import {
  PlatformAgentService,
  PlatformChatHistoryService,
  PlatformChatQueueService,
} from '@wispace/chat-agent';
import { PrivacyDataService } from '@wispace/database';
import { StudyReminderSyncService } from '@wispace/study-reminder-shared';
import { WispaceCalendarService } from '@wispace/wispace-client';
import { ZaloReportCronService } from '../zalo-chat/infrastructure/persistence/zalo-report-cron.service';
import { ZaloOpsController } from './zalo-ops.controller';

describe('Zalo privacy HTTP contract', () => {
  let app: INestApplication;
  const privacyService = {
    unlink: jest.fn(),
    delete: jest.fn(),
    export: jest.fn(),
  };

  beforeEach(async () => {
    privacyService.unlink.mockResolvedValue({
      unlinked: true,
      status: 'complete',
    });
    privacyService.delete.mockResolvedValue({
      deleted: true,
      status: 'complete',
      outstandingStores: [],
    });
    const moduleFixture = await Test.createTestingModule({
      controllers: [ZaloOpsController],
      providers: [
        {
          provide: StudyReminderSyncService,
          useValue: { syncUpcomingSessions: jest.fn() },
        },
        {
          provide: ZaloReportCronService,
          useValue: { sendDailyReports: jest.fn() },
        },
        { provide: WispaceCalendarService, useValue: {} },
        { provide: PrivacyDataService, useValue: privacyService },
        {
          provide: PlatformAgentService,
          useValue: { clearClarificationState: jest.fn() },
        },
        {
          provide: PlatformChatHistoryService,
          useValue: { clear: jest.fn() },
        },
        {
          provide: PlatformChatQueueService,
          useValue: { clear: jest.fn() },
        },
        {
          provide: BotMetricsService,
          useValue: { incPrivacyCleanupAttempt: jest.fn() },
        },
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

  it('returns 200 for a complete unlink and preserves the mutation boolean', async () => {
    await request(app.getHttpServer())
      .post('/v1/zalo/privacy/unlink')
      .send({ externalUserId: 'zalo-user-1' })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({ unlinked: true, status: 'complete' });
      });

    expect(privacyService.unlink).toHaveBeenLastCalledWith(
      'zalo',
      'zalo-user-1',
      expect.any(Object),
      undefined,
    );
  });

  it('returns 202 with outstanding stores for an incomplete delete', async () => {
    privacyService.delete.mockResolvedValueOnce({
      deleted: true,
      status: 'incomplete',
      cleanupId: 'opaque-zalo-cleanup',
      outstandingStores: ['chat_history'],
    });

    await request(app.getHttpServer())
      .post('/v1/zalo/privacy/delete')
      .send({ externalUserId: 'zalo-user-1' })
      .expect(202)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          deleted: true,
          status: 'incomplete',
          cleanupId: 'opaque-zalo-cleanup',
          outstandingStores: ['chat_history'],
        });
      });

    expect(privacyService.delete).toHaveBeenLastCalledWith(
      'zalo',
      'zalo-user-1',
      expect.any(Object),
      undefined,
    );
  });

  it('returns 409 for a generation conflict', async () => {
    privacyService.unlink.mockResolvedValueOnce({
      unlinked: false,
      conflict: true,
    });

    await request(app.getHttpServer())
      .post('/v1/zalo/privacy/unlink')
      .send({
        externalUserId: 'zalo-user-1',
        expectedMapping: {
          exists: true,
          userId: 42,
          mappingGeneration: '3',
        },
      })
      .expect(409);

    expect(privacyService.unlink).toHaveBeenLastCalledWith(
      'zalo',
      'zalo-user-1',
      expect.any(Object),
      { exists: true, userId: 42, mappingGeneration: '3' },
    );
  });

  it('validates the external identity boundary', async () => {
    await request(app.getHttpServer())
      .post('/v1/zalo/privacy/delete')
      .send({ externalUserId: 123 })
      .expect(400);

    await request(app.getHttpServer())
      .post('/v1/zalo/privacy/delete')
      .send({
        externalUserId: 'zalo-user-1',
        expectedMapping: { exists: 'yes' },
      })
      .expect(400);
  });
});
