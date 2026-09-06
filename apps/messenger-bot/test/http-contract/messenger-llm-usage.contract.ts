import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { LlmUsageController } from '@messenger/modules/llm-usage/presentation/controllers/llm-usage.controller';
import { LlmUsageQueryService } from '@messenger/modules/llm-usage/application/services/llm-usage-query.service';
import { InternalApiKeyGuard } from '@wispace/bot-common/guard';
import { ThrottlerGuard } from '@nestjs/throttler';

function buildMockQueryService() {
  return {
    getUserSummary: jest.fn().mockResolvedValue({
      psid: 'psid-1',
      totalTokens: 1500,
      byFeature: [{ feature: 'chat', tokens: 1500 }],
    }),
    getFleetSummary: jest.fn().mockResolvedValue({
      date: '2026-09-05',
      totalTokens: 5000,
      byFeature: [{ feature: 'chat', tokens: 5000 }],
    }),
  };
}

describe('LLM usage endpoints (HTTP contract)', () => {
  let app: INestApplication<App>;
  let queryService: ReturnType<typeof buildMockQueryService>;

  beforeEach(async () => {
    queryService = buildMockQueryService();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [LlmUsageController],
      providers: [{ provide: LlmUsageQueryService, useValue: queryService }],
    })
      .overrideGuard(InternalApiKeyGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('v1');
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  describe('GET /messenger/ops/llm-usage/summary', () => {
    it('returns user summary with default params', async () => {
      await request(app.getHttpServer())
        .get('/v1/messenger/ops/llm-usage/summary')
        .expect(200)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            psid: 'psid-1',
            totalTokens: expect.any(Number),
          });
        });
    });

    it('passes query params to service', async () => {
      await request(app.getHttpServer())
        .get('/v1/messenger/ops/llm-usage/summary')
        .query({ psid: 'psid-2', from: '2026-09-01', to: '2026-09-05' })
        .expect(200);

      expect(queryService.getUserSummary).toHaveBeenCalledWith({
        psid: 'psid-2',
        userId: undefined,
        from: '2026-09-01',
        to: '2026-09-05',
      });
    });

    it('parses numeric userId from query string', async () => {
      await request(app.getHttpServer())
        .get('/v1/messenger/ops/llm-usage/summary')
        .query({ userId: '42' })
        .expect(200);

      expect(queryService.getUserSummary).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 42 }),
      );
    });

    it('ignores non-numeric userId', async () => {
      await request(app.getHttpServer())
        .get('/v1/messenger/ops/llm-usage/summary')
        .query({ userId: 'abc' })
        .expect(200);

      expect(queryService.getUserSummary).toHaveBeenCalledWith(
        expect.objectContaining({ userId: undefined }),
      );
    });
  });

  describe('GET /v1/messenger/ops/llm-usage/fleet', () => {
    it('returns fleet summary with default date', async () => {
      await request(app.getHttpServer())
        .get('/v1/messenger/ops/llm-usage/fleet')
        .expect(200)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            totalTokens: expect.any(Number),
          });
        });
    });

    it('passes date query param', async () => {
      await request(app.getHttpServer())
        .get('/v1/messenger/ops/llm-usage/fleet')
        .query({ date: '2026-09-05' })
        .expect(200);

      expect(queryService.getFleetSummary).toHaveBeenCalledWith({
        date: '2026-09-05',
      });
    });
  });
});
