import type { ConfigService } from '@nestjs/config';
import type { BotMetricsService } from '@wispace/bot-metrics';
import type { ZaloOutboundPort } from '@zalo/modules/zalo-chat/application/ports/zalo-outbound.port';
import type { ZaloWelcomeRecordRepositoryPort } from '../../domain/ports/zalo-welcome-record.repository.port';
import { ZaloWelcomeService } from './zalo-welcome.service';

function buildConfig(): ConfigService {
  return {
    get: jest.fn().mockReturnValue(undefined),
  } as unknown as ConfigService;
}

function buildService(overrides: {
  claim?: boolean;
  outcome?: 'sent' | 'ambiguous' | 'not_sent' | 'rate_limited';
}) {
  const records: ZaloWelcomeRecordRepositoryPort = {
    tryClaimWelcome: jest.fn().mockResolvedValue(overrides.claim ?? true),
    markWelcomed: jest.fn().mockResolvedValue(undefined),
  };
  const outbound: ZaloOutboundPort = {
    sendText: jest.fn().mockResolvedValue(overrides.outcome ?? 'sent'),
    sendTextForRetry: jest.fn(),
    isAmbiguousDeliveryError: jest.fn(),
  };
  const service = new ZaloWelcomeService(records, outbound, buildConfig(), {
    incWelcomeAttempt: jest.fn(),
  } as unknown as BotMetricsService);
  return { service, records, outbound };
}

describe('ZaloWelcomeService', () => {
  it('atomically claims and marks only an acknowledged welcome', async () => {
    const { service, records, outbound } = buildService({});

    await expect(service.welcomeIfDue('zalo-1', 42)).resolves.toBe('sent');
    expect(records.tryClaimWelcome).toHaveBeenCalledWith(
      'zalo-1',
      86_400_000,
      60_000,
    );
    expect(outbound.sendText).toHaveBeenCalledWith(
      'zalo-1',
      expect.stringContaining('liên kết thành công'),
      { userId: 42 },
    );
    expect(records.markWelcomed).toHaveBeenCalledWith('zalo-1', 'linked');
  });

  it('skips a claimed-in-window welcome without sending', async () => {
    const { service, records, outbound } = buildService({ claim: false });

    await expect(service.welcomeIfDue('zalo-1', 42)).resolves.toBe('skipped');
    expect(outbound.sendText).not.toHaveBeenCalled();
    expect(records.markWelcomed).not.toHaveBeenCalled();
  });

  it('marks an organic follow welcome with the organic source', async () => {
    const { service, records, outbound } = buildService({});

    await expect(
      service.organicWelcomeIfDue('zalo-1', 'hello from WISPACE'),
    ).resolves.toBe('sent');
    expect(outbound.sendText).toHaveBeenCalledWith(
      'zalo-1',
      'hello from WISPACE',
      undefined,
    );
    expect(records.markWelcomed).toHaveBeenCalledWith('zalo-1', 'organic');
  });

  it('does not mark an ambiguous or failed delivery as welcomed', async () => {
    const { service, records } = buildService({ outcome: 'ambiguous' });

    await expect(service.welcomeIfDue('zalo-1', 42)).resolves.toBe('error');
    expect(records.markWelcomed).not.toHaveBeenCalled();
  });
});
