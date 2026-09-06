import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
  ForbiddenException,
} from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { MessengerController } from '@messenger/modules/messenger/presentation/controllers/messenger.controller';
import { MessengerService } from '@messenger/modules/messenger/application/services/messenger.service';
import { MessengerProfileService } from '@messenger/modules/messenger/infrastructure/meta/messenger-profile.service';
import { InternalApiKeyGuard } from '@wispace/bot-common/guard';
import { ThrottlerGuard } from '@nestjs/throttler';
import { MessengerWebhookSignatureGuard } from '@messenger/shared/common/guards/messenger-webhook-signature.guard';
import { ConfigService } from '@nestjs/config';

describe('Messenger webhook (HTTP contract)', () => {
  let app: INestApplication<App>;

  const mockMessengerService = {
    verifyWebhook: jest.fn(),
    handleWebhook: jest.fn(),
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
        {
          provide: ConfigService,
          useValue: { get: (key: string, fallback?: unknown) => fallback },
        },
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
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  describe('GET /v1/webhook (Meta challenge)', () => {
    it('returns challenge when verify token matches', async () => {
      mockMessengerService.verifyWebhook.mockReturnValue('challenge-123');

      await request(app.getHttpServer())
        .get('/v1/webhook')
        .query({ 'hub.verify_token': 'test', 'hub.challenge': 'challenge-123' })
        .expect(200)
        .expect('challenge-123');

      expect(mockMessengerService.verifyWebhook).toHaveBeenCalledWith(
        'test',
        'challenge-123',
      );
    });

    it('returns 403 when verify token is wrong', async () => {
      mockMessengerService.verifyWebhook.mockImplementation(() => {
        throw new ForbiddenException('Invalid verify token');
      });

      await request(app.getHttpServer())
        .get('/v1/webhook')
        .query({ 'hub.verify_token': 'wrong', 'hub.challenge': 'abc' })
        .expect(403);
    });

    it('returns 403 when verify token is missing', async () => {
      mockMessengerService.verifyWebhook.mockImplementation(() => {
        throw new ForbiddenException('Invalid verify token');
      });

      await request(app.getHttpServer())
        .get('/v1/webhook')
        .query({ 'hub.challenge': 'abc' })
        .expect(403);
    });
  });

  describe('POST /v1/webhook (ingestion)', () => {
    const validPayload = {
      object: 'page',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'user-1' },
              message: { mid: 'mid-1', text: 'hello' },
            },
          ],
        },
      ],
    };

    it('accepts valid message and returns ok with accepted count', async () => {
      mockMessengerService.handleWebhook.mockResolvedValue({
        accepted: 1,
        duplicates: 0,
      });

      await request(app.getHttpServer())
        .post('/v1/webhook')
        .send(validPayload)
        .expect(200)
        .expect(({ body }) => {
          expect(body.ok).toBe(true);
          expect(body.accepted).toBe(1);
          expect(body.duplicates).toBe(0);
        });
    });

    it('deduplicates second delivery of same mid', async () => {
      mockMessengerService.handleWebhook
        .mockResolvedValueOnce({ accepted: 1, duplicates: 0 })
        .mockResolvedValueOnce({ accepted: 0, duplicates: 1 });

      await request(app.getHttpServer())
        .post('/v1/webhook')
        .send(validPayload)
        .expect(200);

      await request(app.getHttpServer())
        .post('/v1/webhook')
        .send(validPayload)
        .expect(200)
        .expect(({ body }) => {
          expect(body.ok).toBe(true);
          expect(body.accepted).toBe(0);
          expect(body.duplicates).toBe(1);
        });
    });

    it('returns 404 for non-page object', async () => {
      await request(app.getHttpServer())
        .post('/v1/webhook')
        .send({ object: 'not_page', entry: [] })
        .expect(404);
    });

    it('rejects oversized batch via ValidationPipe (@ArrayMaxSize)', async () => {
      // MessengerWebhookPayloadDto has @ArrayMaxSize(50) on entry array.
      // Sending 51 entries triggers DTO validation failure (400).
      const oversized = {
        object: 'page',
        entry: Array.from({ length: 51 }, (_, i) => ({
          messaging: [
            {
              sender: { id: `u${i}` },
              message: { mid: `m${i}`, text: `${i}` },
            },
          ],
        })),
      };

      await request(app.getHttpServer())
        .post('/v1/webhook')
        .send(oversized)
        .expect(400);
    });

    it('returns 400 for malformed body (missing object field)', async () => {
      await request(app.getHttpServer())
        .post('/v1/webhook')
        .send({ entry: [] })
        .expect(400);
    });

    it('accepts empty valid batch', async () => {
      mockMessengerService.handleWebhook.mockResolvedValue({
        accepted: 0,
        duplicates: 0,
      });

      await request(app.getHttpServer())
        .post('/v1/webhook')
        .send({ object: 'page', entry: [{ messaging: [] }] })
        .expect(200)
        .expect(({ body }) => {
          expect(body.ok).toBe(true);
          expect(body.accepted).toBe(0);
        });
    });
  });
});
