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
});
