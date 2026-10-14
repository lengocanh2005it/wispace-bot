import { InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatRateLimitConfigService } from './chat-rate-limit-config.service';
import { ChatRateLimitStartupService } from './chat-rate-limit-startup.service';

describe('ChatRateLimitStartupService', () => {
  let service: ChatRateLimitStartupService;
  let configService: jest.Mocked<ConfigService>;
  let chatRateLimitConfigService: jest.Mocked<ChatRateLimitConfigService>;

  function setup(opts: {
    nodeEnv?: string;
    enforceProd?: string;
    rateLimitEnabled?: boolean;
    burstStoreUnsupported?: boolean;
  }) {
    configService = {
      get: jest.fn((key: string) => {
        if (key === 'NODE_ENV') return opts.nodeEnv;
        if (key === 'ENFORCE_PROD_CHAT_QUOTA') return opts.enforceProd;
        return undefined;
      }),
    } as unknown as jest.Mocked<ConfigService>;

    chatRateLimitConfigService = {
      isEnabled: jest.fn().mockReturnValue(opts.rateLimitEnabled ?? false),
      isBurstStoreValueUnsupported: jest
        .fn()
        .mockReturnValue(opts.burstStoreUnsupported ?? false),
    } as unknown as jest.Mocked<ChatRateLimitConfigService>;

    service = new ChatRateLimitStartupService(
      configService,
      chatRateLimitConfigService,
    );
  }

  it('throws in production when rate limit is disabled', () => {
    setup({ nodeEnv: 'production', rateLimitEnabled: false });

    expect(() => service.onModuleInit()).toThrow(InternalServerErrorException);
    expect(() => service.onModuleInit()).toThrow('H1');
  });

  it('does not throw in production when rate limit is enabled', () => {
    setup({ nodeEnv: 'production', rateLimitEnabled: true });

    expect(() => service.onModuleInit()).not.toThrow();
  });

  it('does not throw in non-production environments', () => {
    setup({ nodeEnv: 'development', rateLimitEnabled: false });

    expect(() => service.onModuleInit()).not.toThrow();
  });

  it('throws when ENFORCE_PROD_CHAT_QUOTA is set without NODE_ENV=production and rate limit disabled', () => {
    setup({ enforceProd: 'true', rateLimitEnabled: false });

    expect(() => service.onModuleInit()).toThrow(InternalServerErrorException);
  });

  // #1288 retired the memory store. In production a stale value must be loud:
  // silently degrading to Postgres hides a misconfiguration the next operator
  // inherits. Same gate and same throw as the H1 check above, so quota config
  // has one validation pattern rather than two.
  it('throws in production when CHAT_BURST_STORE holds a value this build retired (#1288)', () => {
    setup({
      nodeEnv: 'production',
      rateLimitEnabled: true,
      burstStoreUnsupported: true,
    });

    expect(() => service.onModuleInit()).toThrow(InternalServerErrorException);
    expect(() => service.onModuleInit()).toThrow('CHAT_BURST_STORE');
  });

  it('does not throw in production when CHAT_BURST_STORE is a supported value', () => {
    setup({
      nodeEnv: 'production',
      rateLimitEnabled: true,
      burstStoreUnsupported: false,
    });

    expect(() => service.onModuleInit()).not.toThrow();
  });

  it('does not block a developer on a stale CHAT_BURST_STORE', () => {
    setup({ nodeEnv: 'development', burstStoreUnsupported: true });

    expect(() => service.onModuleInit()).not.toThrow();
  });
});
