import { DataSource, Repository } from 'typeorm';
import {
  resolveCanonicalPlatform,
  CanonicalPlatformService,
} from './canonical-platform.service';
import { UserNotificationPreferenceEntity } from '../../entities/user-notification-preference.entity';

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

  describe('getCanonicalPlatformsForUsers', () => {
    it('resolves unique learner IDs in one query and preserves no-link semantics', async () => {
      queryMock.mockResolvedValueOnce([
        {
          user_id: 42,
          preferred_platform: 'discord',
          active_platforms: ['zalo', 'discord', 'messenger'],
        },
        {
          user_id: 7,
          preferred_platform: null,
          active_platforms: [],
        },
      ]);

      const result = await service.getCanonicalPlatformsForUsers([42, 42, 7]);

      expect(result).toEqual(
        new Map<number, 'discord' | undefined>([
          [42, 'discord'],
          [7, undefined],
        ]),
      );
      expect(queryMock).toHaveBeenCalledTimes(1);
      expect(queryMock).toHaveBeenCalledWith(
        expect.stringContaining('unnest($1::int[])'),
        [[42, 7]],
      );
    });

    it('uses preferred platform only when it is active and otherwise applies priority', async () => {
      queryMock.mockResolvedValueOnce([
        {
          user_id: 1,
          preferred_platform: 'messenger',
          active_platforms: ['discord', 'zalo'],
        },
        {
          user_id: 2,
          preferred_platform: null,
          active_platforms: ['messenger', 'discord'],
        },
        {
          user_id: 3,
          preferred_platform: 'discord',
          active_platforms: ['messenger', 'discord', 'zalo'],
        },
      ]);

      await expect(
        service.getCanonicalPlatformsForUsers([1, 2, 3]),
      ).resolves.toEqual(
        new Map([
          [1, 'zalo'],
          [2, 'discord'],
          [3, 'discord'],
        ]),
      );
    });

    it('fails closed when the database omits a requested learner', async () => {
      queryMock.mockResolvedValueOnce([
        {
          user_id: 42,
          preferred_platform: null,
          active_platforms: ['messenger'],
        },
      ]);

      await expect(
        service.getCanonicalPlatformsForUsers([42, 7]),
      ).rejects.toThrow('incomplete results');
    });

    it('fails closed when the database returns an unknown platform', async () => {
      queryMock.mockResolvedValueOnce([
        {
          user_id: 42,
          preferred_platform: null,
          active_platforms: ['telegram'],
        },
      ]);

      await expect(service.getCanonicalPlatformsForUsers([42])).rejects.toThrow(
        'unknown platform',
      );
    });

    it('does not query for an empty input', async () => {
      await expect(service.getCanonicalPlatformsForUsers([])).resolves.toEqual(
        new Map(),
      );

      expect(queryMock).not.toHaveBeenCalled();
    });
  });

  it('resolves canonical platform from database query with preference', async () => {
    queryMock.mockResolvedValueOnce([
      {
        user_id: 42,
        preferred_platform: 'discord',
        active_platforms: ['zalo', 'discord', 'messenger'],
      },
    ]);

    const canonical = await service.getCanonicalPlatformForUser(42);
    expect(canonical).toBe('discord');
  });

  it('resolves deterministic fallback (zalo) when user has multiple links and no preference', async () => {
    queryMock.mockResolvedValueOnce([
      {
        user_id: 42,
        preferred_platform: null,
        active_platforms: ['zalo', 'discord', 'messenger'],
      },
    ]);

    const canonical = await service.getCanonicalPlatformForUser(42);
    expect(canonical).toBe('zalo');
  });

  it('returns undefined when user has no active links', async () => {
    queryMock.mockResolvedValueOnce([
      {
        user_id: 42,
        preferred_platform: null,
        active_platforms: [],
      },
    ]);

    const canonical = await service.getCanonicalPlatformForUser(42);
    expect(canonical).toBeUndefined();
  });

  it('checks if platform is canonical for user via isCanonicalForUser', async () => {
    queryMock.mockResolvedValue([
      {
        user_id: 42,
        preferred_platform: 'discord',
        active_platforms: ['zalo', 'discord', 'messenger'],
      },
    ]);

    const discordCheck = await service.isCanonicalForUser(42, 'discord');
    expect(discordCheck).toEqual({
      isCanonical: true,
      canonicalPlatform: 'discord',
    });

    const messengerCheck = await service.isCanonicalForUser(42, 'messenger');
    expect(messengerCheck).toEqual({
      isCanonical: false,
      canonicalPlatform: 'discord',
    });
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
