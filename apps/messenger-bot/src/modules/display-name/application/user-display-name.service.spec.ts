import { UserDisplayNameService } from './user-display-name.service';
import type { MessengerMappingRepositoryPort } from '@messenger/modules/messenger/domain/repositories/messenger-mapping.repository.port';
import type { UserDisplayNameCachePort } from '../domain/user-display-name-cache.port';

describe('UserDisplayNameService', () => {
  const userReader = {
    findById: jest.fn(),
    findByIds: jest.fn().mockResolvedValue([]),
  };

  const mappingReader = {
    findActiveMappingByPsid: jest.fn(),
  } as unknown as MessengerMappingRepositoryPort;

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
      userReader as never,
      mappingReader,
      cache,
    );

    await expect(service.resolveDisplayName({ userId: 7 })).resolves.toBe('Hà');
    expect(userReader.findById).not.toHaveBeenCalled();
  });

  it('loads from postgres on cache miss and writes redis', async () => {
    cacheGet.mockResolvedValue(null);
    userReader.findById.mockResolvedValue({
      id: 7,
      displayName: 'Minh',
      username: 'minh01',
    });

    const service = new UserDisplayNameService(
      userReader as never,
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
    userReader.findById.mockResolvedValue({
      id: 7,
      displayName: 'An',
      username: null,
    });

    const service = new UserDisplayNameService(
      userReader as never,
      mappingReader,
      cache,
    );

    await expect(service.resolveDisplayName({ userId: 7 })).resolves.toBe('An');
    expect(cacheGet).not.toHaveBeenCalled();
  });

  it('uses fallback when display_name is null', async () => {
    cacheGet.mockResolvedValue(null);
    userReader.findById.mockResolvedValue({
      id: 7,
      displayName: null,
      username: null,
    });

    const service = new UserDisplayNameService(
      userReader as never,
      mappingReader,
      cache,
    );

    await expect(service.resolveDisplayName({ userId: 7 })).resolves.toBe(
      'Chào bạn nha',
    );
  });
});
