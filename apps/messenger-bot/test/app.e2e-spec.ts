import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { randomUUID } from 'node:crypto';
import { AppModule } from './../src/app.module';

interface MessengerProfilePayload {
  get_started: {
    payload: string;
  };
  greeting: Array<{
    text: string;
  }>;
  persistent_menu: Array<{
    call_to_actions: unknown[];
  }>;
}

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;
  let fetchMock: jest.Mock;
  let dataSource: DataSource;

  /** Poll until `predicate` holds, so fire-and-forget dispatch can settle. */
  const waitFor = async (
    predicate: () => boolean,
    timeoutMs = 5_000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error('Timed out waiting for asynchronous condition');
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  /** Poll an async query until it returns true. */
  const waitForRow = async (
    predicate: () => Promise<boolean>,
    timeoutMs = 5_000,
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return true;
      if (Date.now() > deadline) {
        throw new Error('Timed out waiting for row');
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  beforeAll(async () => {
    process.env.PAGE_ACCESS_TOKEN = 'test-page-access-token';
    process.env.VERIFY_TOKEN = 'wispace_verify_token';
    process.env.GRAPH_API_VERSION = 'v25.0';
    process.env.MESSENGER_PAGE_ID = '1192471430606671';
    process.env.MESSENGER_WEBHOOK_SIGNATURE_VERIFY = 'false';

    // AppModule boots the real DI graph, so the same env the boot smoke test
    // (`src/app.boot.spec.ts`) sets is required here. Postgres/Redis must be
    // reachable; see `test/README.md` for how to start them locally.
    process.env.INTERNAL_API_KEY = 'test-internal-key';
    process.env.OPENAI_API_KEY = 'sk-test-key';
    process.env.OPENAI_MODEL = 'test-model';
    process.env.LLM_ALLOWED_BASE_URLS = 'api.openai.com';
    process.env.LLM_ALLOWED_MODELS = 'openai:test-model';
    process.env.WISPACE_INTERNAL_KEY = 'test-wispace-key';
    process.env.WISPACE_API_PRECREATE_EXERCISE_URL =
      'https://testbackend.example.com/precreate-exercise';
    process.env.WISPACE_API_PRECREATE_EXERCISE_TIMEOUT_MS = '30000';
    process.env.WISPACE_API_REENGAGEMENT_URL =
      'https://testbackend.example.com/api/bot/reengagement';
    process.env.WISPACE_API_VERIFY_TOKEN_URL =
      'https://testbackend.example.com/verify-token';
    process.env.CHAT_FREE_FORM_DAILY_LIMIT = '15';
    process.env.CHAT_BURST_PER_MINUTE = '3';
    process.env.CHAT_QUOTA_REMAINING_HINT_THRESHOLD = '3';
    // Runs without Redis — force memory stores so the fail-closed guards
    // do not trip (a real deploy with CHAT_HISTORY_STORE=redis needs Redis).
    process.env.CHAT_HISTORY_STORE = 'memory';
    process.env.CHAT_QUEUE_STORE = 'memory';
    process.env.CHAT_USAGE_TIMEZONE = 'Asia/Ho_Chi_Minh';
    process.env.STUDY_REMINDER_MINUTES_BEFORE = '30';
    process.env.STUDY_REMINDER_MIN_LEAD_MINUTES = '5';
    process.env.STUDY_REMINDER_SYNC_HORIZON_HOURS = '48';
    process.env.STUDY_REMINDER_MAX_RETRIES = '3';
    process.env.STUDY_REMINDER_RETRY_BACKOFF_MINUTES = '2';
    process.env.STUDY_REMINDER_JOB_RETENTION_DAYS = '7';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    dataSource = moduleFixture.get(DataSource);
    app = moduleFixture.createNestApplication({ rawBody: true });
    // Mirrors `bootstrapBot`: the app serves every route under the `v1`
    // prefix. Tests that build the app directly must apply it themselves.
    app.setGlobalPrefix('v1', {
      exclude: ['health', 'health/*path', 'metrics'],
    });
    await app.init();
  }, 60_000);

  // The app is booted once for the whole suite on purpose. Webhook ingestion
  // dispatches fire-and-forget, so a per-test app would tear down the TypeORM
  // pool while an earlier dispatch is still writing its message log.
  beforeEach(() => {
    fetchMock = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        // Only the WISPACE link-verify endpoint reads a body; Meta calls are
        // fire-and-forget. The shape follows
        // packages/wispace-client/contracts/wispace-verify-token.contract.json.
        text: () => Promise.resolve(JSON.stringify({ success: false })),
      }),
    );
    global.fetch = fetchMock;
  });

  it('/v1 (GET)', () => {
    return request(app.getHttpServer())
      .get('/v1')
      .expect(200)
      .expect('Messenger AI Notification API is running');
  });

  it('/v1/webhook (GET) verifies Meta challenge', () => {
    return request(app.getHttpServer())
      .get('/v1/webhook')
      .query({
        'hub.verify_token': 'wispace_verify_token',
        'hub.challenge': 'challenge-123',
      })
      .expect(200)
      .expect('challenge-123');
  });

  it('/v1/webhook (POST) handles Get Started referral and sends welcome message', async () => {
    // Unique per run so a persisted mapping from an earlier run cannot make
    // this pass (or fail) for the wrong reason.
    const psid = `e2e-${randomUUID()}`;
    const referralRef = `ref-${randomUUID()}`;
    await request(app.getHttpServer())
      .post('/v1/webhook')
      .send({
        object: 'page',
        entry: [
          {
            messaging: [
              {
                sender: {
                  id: psid,
                },
                postback: {
                  payload: 'GET_STARTED',
                  referral: {
                    ref: referralRef,
                    source: 'SHORTLINK',
                    type: 'OPEN_THREAD',
                  },
                },
              },
            ],
          },
        ],
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({
          ok: true,
          accepted: 1,
          duplicates: 0,
        });
      });

    // Webhook ingestion is durable + fire-and-forget (InlineWebhookInboundDispatcher
    // deliberately does not block the HTTP response), so the welcome send lands
    // shortly after the 200.
    // The referral also triggers an account-link verify against WISPACE
    // (which the stubbed fetch answers), so assert on the welcome message
    // itself rather than on a total call count.
    const isWelcomeSend = ([url, init]: [URL, RequestInit]) =>
      String(url).includes('graph.facebook.com') &&
      String(init?.body ?? '').includes('Chào bạn! 👋');
    await waitFor(() =>
      fetchMock.mock.calls.some((call) =>
        isWelcomeSend(call as [URL, RequestInit]),
      ),
    );

    const [url, options] = fetchMock.mock.calls.find((call) =>
      isWelcomeSend(call as [URL, RequestInit]),
    ) as [URL, RequestInit];
    expect(String(url)).toContain(
      'https://graph.facebook.com/v25.0/me/messages',
    );
    expect(String(url)).not.toContain('access_token=');
    expect(options.headers).toEqual(
      expect.objectContaining({
        Authorization: 'Bearer test-page-access-token',
      }),
    );
    expect(JSON.parse(options.body as string)).toEqual({
      recipient: {
        id: psid,
      },
      message: {
        text: expect.stringContaining('Chào bạn! 👋'),
      },
    });

    // `MessengerOutboundService.sendTextViaPsid` records the send with a
    // floating `void repository.logMessage(...)`. It normally lands right
    // after the HTTP call, but nothing awaits it — so wait for the row before
    // the suite tears the pool down, otherwise the write outlives the test and
    // surfaces as an unhandled rejection.
    const welcomeLog = await waitForRow(() =>
      dataSource
        .createQueryBuilder()
        .select('1')
        .from('message_logs', 'message_logs')
        .where('external_user_id = :psid', { psid })
        .andWhere('message_type = :type', { type: 'WELCOME' })
        .getExists(),
    );
    expect(welcomeLog).toBe(true);
  });

  it('/v1/messenger/profile/setup configures Get Started, greeting, and menu', async () => {
    await request(app.getHttpServer())
      .post('/v1/messenger/profile/setup')
      // `setupProfile` is ops-only (`InternalApiKeyGuard`), per
      // apps/messenger-bot/docs/study-session-reminder.md.
      .set('X-Internal-Api-Key', 'test-internal-key')
      .expect(200)
      .expect({
        ok: true,
      });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const deleteCall = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(deleteCall[0])).toContain(
      'https://graph.facebook.com/v25.0/me/messenger_profile',
    );
    expect(deleteCall[1].method).toBe('DELETE');

    const [url, options] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(String(url)).toContain(
      'https://graph.facebook.com/v25.0/me/messenger_profile',
    );
    const payload = JSON.parse(
      options.body as string,
    ) as MessengerProfilePayload;
    expect(payload.get_started).toEqual({
      payload: 'GET_STARTED',
    });
    expect(payload.greeting[0].text).toContain('WISPACE');
    expect(payload.persistent_menu[0].call_to_actions).toHaveLength(1);
    expect(payload.persistent_menu[0].call_to_actions).toEqual([
      {
        type: 'postback',
        title: 'Đăng ký báo cáo',
        payload: 'REGISTER_LEARNING_REPORT',
      },
    ]);
  });

  afterAll(async () => {
    await app.close();
  }, 30_000);
});
