import { UserDisplayNameService } from './user-display-name.service';
import type { MessengerRepositoryPort } from '@messenger/modules/messenger/domain/repositories/messenger.repository.port';
import type { UserDisplayNameCachePort } from '../domain/user-display-name-cache.port';

describe('UserDisplayNameService', () => {
  const userRepo = {
    findOne: jest.fn(),
  };

  const mappingReader: Pick<
    MessengerRepositoryPort,
    'findActiveMappingByPsid'
  > = {
    findActiveMappingByPsid: jest.fn(),
  };

  const cacheGet = jest.fn();
  const cacheSet = jest.fn();
  const cacheIsAvailable = jest.fn().mockReturnValue(true);

  const cache: UserDisplayNameCachePort = {
    isAvailable: cacheIsAvailable,
    get: cacheGet,
    set: cacheSet,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns cached display name without hitting postgres', async () => {
    cacheGet.mockResolvedValue({
      displayName: 'Hà',
      username: null,
    });

    const service = new UserDisplayNameService(
      userRepo as never,
      mappingReader,
      cache,
    );

    await expect(service.resolveDisplayName({ userId: 7 })).resolves.toBe('Hà');
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it('loads from postgres on cache miss and writes redis', async () => {
    cacheGet.mockResolvedValue(null);
    userRepo.findOne.mockResolvedValue({
      id: 7,
      displayName: 'Minh',
      username: 'minh01',
    });

    const service = new UserDisplayNameService(
      userRepo as never,
      mappingReader,
      cache,
    );

    await expect(service.resolveDisplayName({ userId: 7 })).resolves.toBe(
      'Minh',
    );
    expect(cacheSet).toHaveBeenCalledWith(7, {
      displayName: 'Minh',
      username: 'minh01',
    });
  });

  it('falls back to postgres when redis cache unavailable', async () => {
    cacheIsAvailable.mockReturnValue(false);
    userRepo.findOne.mockResolvedValue({
      id: 7,
      displayName: 'An',
      username: null,
    });

    const service = new UserDisplayNameService(
      userRepo as never,
      mappingReader,
      cache,
    );

    await expect(service.resolveDisplayName({ userId: 7 })).resolves.toBe('An');
    expect(cacheGet).not.toHaveBeenCalled();
  });

  it('uses fallback when display_name is null', async () => {
    cacheGet.mockResolvedValue(null);
    userRepo.findOne.mockResolvedValue({
      id: 7,
      displayName: null,
      username: null,
    });

    const service = new UserDisplayNameService(
      userRepo as never,
      mappingReader,
      cache,
    );

    await expect(service.resolveDisplayName({ userId: 7 })).resolves.toBe(
      'Chào bạn nha',
    );
  });
});
