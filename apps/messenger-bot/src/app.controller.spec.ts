import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppController } from './app.controller';
import { REDIS_CLIENT } from './infrastructure/redis/redis.client.port';
import type { RedisClientPort } from './infrastructure/redis/redis.client.port';

describe('AppController', () => {
  let appController: AppController;
  let redisClient: jest.Mocked<RedisClientPort>;

  beforeEach(async () => {
    redisClient = {
      isEnabled: jest.fn(),
      ping: jest.fn(),
      getNativeClient: jest.fn(),
    };

    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        {
          provide: DataSource,
          useValue: {
            query: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
          },
        },
        {
          provide: REDIS_CLIENT,
          useValue: redisClient,
        },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return API status text', () => {
      expect(appController.getHello()).toBe(
        'Messenger AI Notification API is running',
      );
    });
  });

  describe('health/redis', () => {
    it('returns ok when redis is disabled', async () => {
      redisClient.ping.mockResolvedValue('NO_REDIS');

      await expect(appController.checkRedis()).resolves.toEqual({
        ok: true,
        redis: 'disabled',
      });
    });

    it('returns ok when redis ping succeeds', async () => {
      redisClient.ping.mockResolvedValue('PONG');

      await expect(appController.checkRedis()).resolves.toEqual({
        ok: true,
        redis: 'connected',
      });
    });

    it('throws when redis ping fails', async () => {
      redisClient.ping.mockResolvedValue('connection refused');

      await expect(appController.checkRedis()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });
});
