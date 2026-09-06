import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { MessengerController } from '@messenger/modules/messenger/presentation/controllers/messenger.controller';
import { MessengerService } from '@messenger/modules/messenger/application/services/messenger.service';
import { MessengerProfileService } from '@messenger/modules/messenger/infrastructure/meta/messenger-profile.service';
import { MessengerWebhookSignatureGuard } from '@messenger/shared/common/guards/messenger-webhook-signature.guard';
import { createContractApp } from './helpers';

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
    app = await createContractApp({
      controllers: [MessengerController],
      providers: [
        { provide: MessengerService, useValue: mockMessengerService },
        { provide: MessengerProfileService, useValue: mockProfileService },
      ],
      overrideGuards: [MessengerWebhookSignatureGuard],
    });
  });

  afterEach(async () => {
    await app?.close();
  });

  describe('POST /v1/messenger/profile/setup', () => {
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
