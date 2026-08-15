import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from './../src/app.module';

interface TestDatabase {
  mappings: Array<{
    userId?: number;
    psid: string;
    ref?: string;
    status: string;
  }>;
  logs: Array<{
    userId?: number;
    psid?: string;
    messageType: string;
    status: string;
  }>;
}

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
  let dbPath: string;
  let fetchMock: jest.Mock;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `messenger-test-${randomUUID()}.json`);
    process.env.PAGE_ACCESS_TOKEN = 'test-page-access-token';
    process.env.VERIFY_TOKEN = 'wispace_verify_token';
    process.env.GRAPH_API_VERSION = 'v25.0';
    process.env.MESSENGER_PAGE_ID = '1192471430606671';
    process.env.MESSENGER_DB_PATH = dbPath;
    process.env.MESSENGER_WEBHOOK_SIGNATURE_VERIFY = 'false';

    fetchMock = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve(''),
      }),
    );
    global.fetch = fetchMock;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    await app.init();
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
    await request(app.getHttpServer())
      .post('/v1/webhook')
      .send({
        object: 'page',
        entry: [
          {
            messaging: [
              {
                sender: {
                  id: '123456789',
                },
                postback: {
                  payload: 'GET_STARTED',
                  referral: {
                    ref: '12345',
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
          processed: 1,
          failures: [],
        });
      });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [URL, RequestInit];
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
        id: '123456789',
      },
      message: {
        text: 'Chào bạn! 👋 Mình là trợ lý WISPACE — đồng hành học IELTS Writing cùng bạn. Bạn cứ nhắn nhu cầu tự nhiên, ví dụ như xem tiến độ hay tạo bài tập mới — mình sẽ hỗ trợ bạn nhé!',
      },
    });

    const db = JSON.parse(await readFile(dbPath, 'utf8')) as TestDatabase;
    expect(db.mappings[0]).toMatchObject({
      userId: 12345,
      psid: '123456789',
      ref: '12345',
      status: 'ACTIVE',
    });
    expect(db.logs[0]).toMatchObject({
      userId: 12345,
      psid: '123456789',
      messageType: 'WELCOME',
      status: 'SENT',
    });
  });

  it('/v1/messenger/profile/setup configures Get Started, greeting, and menu', async () => {
    await request(app.getHttpServer())
      .post('/v1/messenger/profile/setup')
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

  afterEach(async () => {
    await app.close();
    await rm(dbPath, { force: true });
  });
});
