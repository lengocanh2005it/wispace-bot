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
import { DiscordReportCronService } from '../discord-chat/application/services/discord-report-cron.service';
import { DiscordOpsController } from './discord-ops.controller';

describe('Discord privacy HTTP contract', () => {
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
      controllers: [DiscordOpsController],
      providers: [
        {
          provide: DiscordReportCronService,
          useValue: { sendScheduledReports: jest.fn() },
        },
        {
          provide: StudyReminderSyncService,
          useValue: { syncUpcomingSessions: jest.fn() },
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
      .overrideProvider(PlatformAgentService)
      .useValue({ clearClarificationState: jest.fn() })
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
      .post('/v1/discord/privacy/unlink')
      .send({ externalUserId: 'discord-user-1' })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({ unlinked: true, status: 'complete' });
      });
  });

  it('returns 202 with outstanding stores for an incomplete delete', async () => {
    privacyService.delete.mockResolvedValueOnce({
      deleted: true,
      status: 'incomplete',
      cleanupId: 'opaque-discord-cleanup',
      outstandingStores: ['chat_history'],
    });

    await request(app.getHttpServer())
      .post('/v1/discord/privacy/delete')
      .send({ externalUserId: 'discord-user-1' })
      .expect(202)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          deleted: true,
          status: 'incomplete',
          cleanupId: 'opaque-discord-cleanup',
          outstandingStores: ['chat_history'],
        });
      });
  });

  it('returns 409 for a generation conflict', async () => {
    privacyService.unlink.mockResolvedValueOnce({
      unlinked: false,
      conflict: true,
    });

    await request(app.getHttpServer())
      .post('/v1/discord/privacy/unlink')
      .send({ externalUserId: 'discord-user-1' })
      .expect(409);
  });

  it('validates the external identity boundary', async () => {
    await request(app.getHttpServer())
      .post('/v1/discord/privacy/delete')
      .send({ externalUserId: 123 })
      .expect(400);
  });
});
