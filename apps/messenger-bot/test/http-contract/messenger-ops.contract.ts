import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { MessengerController } from '@messenger/modules/messenger/presentation/controllers/messenger.controller';
import { MessengerService } from '@messenger/modules/messenger/application/services/messenger.service';
import { MessengerProfileService } from '@messenger/modules/messenger/infrastructure/meta/messenger-profile.service';
import { InternalApiKeyGuard } from '@wispace/bot-common/guard';
import { ThrottlerGuard } from '@nestjs/throttler';
import { MessengerWebhookSignatureGuard } from '@messenger/shared/common/guards/messenger-webhook-signature.guard';

describe('Messenger ops endpoints (HTTP contract)', () => {
  let app: INestApplication<App>;

  const mockMessengerService = {
    verifyWebhook: jest.fn().mockReturnValue('challenge-ok'),
    handleWebhook: jest.fn().mockResolvedValue({ accepted: 1, duplicates: 0 }),
  };

  const mockProfileService = {
    setupProfile: jest.fn().mockResolvedValue({ ok: true }),
  };

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [MessengerController],
      providers: [
        { provide: MessengerService, useValue: mockMessengerService },
        { provide: MessengerProfileService, useValue: mockProfileService },
      ],
    })
      .overrideGuard(InternalApiKeyGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(MessengerWebhookSignatureGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('v1');
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  describe('POST /messenger/profile/setup', () => {
    it('returns 200 with ok:true', async () => {
      await request(app.getHttpServer())
        .post('/v1/messenger/profile/setup')
        .expect(200)
        .expect(({ body }) => {
          expect(body).toEqual({ ok: true });
        });

      expect(mockProfileService.setupProfile).toHaveBeenCalledTimes(1);
    });
  });
});
