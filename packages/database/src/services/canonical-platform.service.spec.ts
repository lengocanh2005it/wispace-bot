import { DataSource, Repository } from 'typeorm';
import {
  resolveCanonicalPlatform,
  CanonicalPlatformService,
} from './canonical-platform.service';
import { UserNotificationPreferenceEntity } from '../entities/user-notification-preference.entity';

describe('resolveCanonicalPlatform (pure function)', () => {
  it('returns undefined when no platforms are active', () => {
    expect(resolveCanonicalPlatform([])).toBeUndefined();
  });

  it('returns the only active platform when single platform linked', () => {
    expect(resolveCanonicalPlatform(['messenger'])).toBe('messenger');
    expect(resolveCanonicalPlatform(['discord'])).toBe('discord');
    expect(resolveCanonicalPlatform(['zalo'])).toBe('zalo');
  });

  it('applies deterministic fallback priority (zalo > discord > messenger) when no preference set', () => {
    expect(resolveCanonicalPlatform(['messenger', 'discord'])).toBe('discord');
    expect(resolveCanonicalPlatform(['messenger', 'zalo'])).toBe('zalo');
    expect(resolveCanonicalPlatform(['discord', 'zalo'])).toBe('zalo');
    expect(resolveCanonicalPlatform(['messenger', 'discord', 'zalo'])).toBe(
      'zalo',
    );
  });

  it('honors valid preferred platform when currently linked', () => {
    expect(resolveCanonicalPlatform(['messenger', 'zalo'], 'messenger')).toBe(
      'messenger',
    );
    expect(
      resolveCanonicalPlatform(['messenger', 'discord', 'zalo'], 'discord'),
    ).toBe('discord');
    expect(resolveCanonicalPlatform(['messenger', 'discord'], 'discord')).toBe(
      'discord',
    );
  });

  it('falls back to deterministic priority when preferred platform is not currently active', () => {
    // User preferred zalo, but unlinked zalo (only messenger & discord active)
    expect(resolveCanonicalPlatform(['messenger', 'discord'], 'zalo')).toBe(
      'discord',
    );
    // User preferred discord, but unlinked discord (only messenger active)
    expect(resolveCanonicalPlatform(['messenger'], 'discord')).toBe(
      'messenger',
    );
  });
});

describe('CanonicalPlatformService', () => {
  let service: CanonicalPlatformService;
  let queryMock: jest.Mock;
  let preferenceRepo: {
    upsert: jest.Mock;
    findOne: jest.Mock;
  };

  beforeEach(() => {
    queryMock = jest.fn();
    preferenceRepo = {
      upsert: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn(),
    };
    const dataSource = {
      query: queryMock,
    } as unknown as DataSource;

    service = new CanonicalPlatformService(
      dataSource,
      preferenceRepo as unknown as Repository<UserNotificationPreferenceEntity>,
    );
  });

  it('resolves canonical platform from database query with preference', async () => {
    queryMock.mockResolvedValueOnce([
      {
        preferred_platform: 'discord',
        zalo_id: 'zalo-1',
        discord_id: 'disc-1',
        messenger_id: 'psid-1',
      },
    ]);

    const canonical = await service.getCanonicalPlatformForUser(42);
    expect(canonical).toBe('discord');
  });

  it('resolves deterministic fallback (zalo) when user has multiple links and no preference', async () => {
    queryMock.mockResolvedValueOnce([
      {
        preferred_platform: null,
        zalo_id: 'zalo-1',
        discord_id: 'disc-1',
        messenger_id: 'psid-1',
      },
    ]);

    const canonical = await service.getCanonicalPlatformForUser(42);
    expect(canonical).toBe('zalo');
  });

  it('returns undefined when user has no active links', async () => {
    queryMock.mockResolvedValueOnce([
      {
        preferred_platform: null,
        zalo_id: null,
        discord_id: null,
        messenger_id: null,
      },
    ]);

    const canonical = await service.getCanonicalPlatformForUser(42);
    expect(canonical).toBeUndefined();
  });

  it('saves preferred platform via upsert', async () => {
    await service.setPreferredPlatform(42, 'discord');

    expect(preferenceRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 42,
        preferredPlatform: 'discord',
      }),
      ['userId'],
    );
  });
});
