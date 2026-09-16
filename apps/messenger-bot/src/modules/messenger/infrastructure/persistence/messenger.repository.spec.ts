import { Repository } from 'typeorm';
import { buildPocPsidToken } from '@messenger/shared/config/poc.constants';
import {
  MessageLogEntity,
  UserPlatformMappingEntity,
} from '@messenger/infrastructure/database/entities';
import { MessengerRepository } from './messenger.repository';

describe('MessengerRepository.upsertPsidUserLink', () => {
  const buildRepo = (transactional = false) => {
    const managerQuery = jest.fn();
    const manager = {
      query: managerQuery,
      ...(transactional
        ? {
            transaction: async (callback: (em: unknown) => Promise<unknown>) =>
              callback({ query: managerQuery }),
          }
        : {}),
    };
    const mappingRepo = {
      manager,
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn((input: Partial<UserPlatformMappingEntity>) => input),
      update: jest.fn(),
      createQueryBuilder: jest.fn(),
    } as unknown as Repository<UserPlatformMappingEntity>;
    const logRepo = {} as unknown as Repository<MessageLogEntity>;
    const repo = new MessengerRepository(mappingRepo, logRepo);
    return { repo, managerQuery };
  };

  it('reactivates an INACTIVE row, then upserts atomically via ON CONFLICT', async () => {
    const { repo, managerQuery } = buildRepo();
    managerQuery
      .mockResolvedValueOnce([[], 0]) // UPDATE INACTIVE (no-op)
      .mockResolvedValueOnce([
        {
          id: 7,
          user_id: 143,
          platform: 'messenger',
          external_user_id: 'psid-1',
          notification_messages_token: buildPocPsidToken('psid-1'),
          topic: 'ielts',
          cadence: 'WEEKLY',
          status: 'ACTIVE',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ]); // INSERT ON CONFLICT — flat rows (tag stays INSERT)

    const result = await repo.upsertPsidUserLink({
      psid: 'psid-1',
      userId: 143,
      topic: 'ielts',
      cadence: 'WEEKLY',
    });

    expect(result).not.toBeNull();
    expect(result!.psid).toBe('psid-1');
    expect(result!.userId).toBe(143);
    expect(managerQuery).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('UPDATE user_platform_mappings'),
      expect.any(Array),
    );
    expect(managerQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "ON CONFLICT (platform, external_user_id)\n          WHERE status = 'ACTIVE' AND external_user_id IS NOT NULL",
      ),
      expect.any(Array),
    );
  });

  it('returns null when CAS guard blocks the update (#383, real [[], 0] tuple shape)', async () => {
    const { repo, managerQuery } = buildRepo();
    managerQuery
      .mockResolvedValueOnce([[], 0]) // UPDATE INACTIVE (no-op)
      .mockResolvedValueOnce([]); // CAS guard blocked — INSERT ON CONFLICT yields no flat rows

    const result = await repo.upsertPsidUserLink({
      psid: 'psid-1',
      userId: 99,
      topic: 'ielts',
      cadence: 'WEEKLY',
    });

    expect(result).toBeNull();
  });

  it('rejects an absent callback observation when a newer tombstone exists', async () => {
    const { repo, managerQuery } = buildRepo(true);
    managerQuery
      .mockResolvedValueOnce([]) // global ownership mutation lock
      .mockResolvedValueOnce([]) // Messenger ownership lock
      .mockResolvedValueOnce([[], 0]) // UPDATE INACTIVE (no-op)
      .mockResolvedValueOnce([]) // no mapping row; use the tombstone fence
      .mockResolvedValueOnce([{ mapping_generation: '8' }]); // latest tombstone

    const result = await repo.upsertPsidUserLink({
      psid: 'psid-1',
      userId: 99,
      expectedGeneration: '7',
    });

    expect(result).toBeNull();
    expect(managerQuery).toHaveBeenCalledTimes(5);
    expect(managerQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO user_platform_mappings'),
      expect.any(Array),
    );
  });

  it('cancels old-owner reminders when a PSID is relinked', async () => {
    const { repo, managerQuery } = buildRepo(true);
    managerQuery
      .mockResolvedValueOnce([]) // global ownership mutation lock
      .mockResolvedValueOnce([]) // Messenger ownership lock
      .mockResolvedValueOnce([[], 0]) // UPDATE INACTIVE (no-op)
      .mockResolvedValueOnce([]) // no privacy tombstone
      .mockResolvedValueOnce([
        {
          id: 7,
          user_id: 200,
          platform: 'messenger',
          external_user_id: 'psid-1',
          notification_messages_token: buildPocPsidToken('psid-1'),
          topic: 'ielts',
          cadence: 'WEEKLY',
          status: 'ACTIVE',
          link_state: 'active',
          mapping_generation: '2',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ]) // relinked mapping
      .mockResolvedValueOnce([{ id: 17 }]); // cancelled reminder job

    const result = await repo.upsertPsidUserLink({
      psid: 'psid-1',
      userId: 200,
    });

    expect(result).toMatchObject({
      psid: 'psid-1',
      mappingGeneration: '2',
    });
    expect(managerQuery).toHaveBeenNthCalledWith(
      6,
      expect.stringContaining('UPDATE study_reminder_jobs'),
      ['messenger', 'psid-1', '2', 'mapping_ownership_changed'],
    );
  });
});

describe('MessengerRepository.deleteMessageLogsOlderThan', () => {
  it('scopes message log deletion to Messenger using bounded batch', async () => {
    const queryMock = jest.fn().mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
    const deleteExecuteMock = jest.fn().mockResolvedValue({ affected: 2 });
    const deleteWhereMock = jest.fn(() => ({
      execute: deleteExecuteMock,
    }));
    const mappingRepo = {} as unknown as Repository<UserPlatformMappingEntity>;
    const logRepo = {
      query: queryMock,
      createQueryBuilder: jest.fn(() => ({
        delete: () => ({
          from: () => ({ where: deleteWhereMock }),
        }),
      })),
    } as unknown as Repository<MessageLogEntity>;
    const repo = new MessengerRepository(mappingRepo, logRepo);
    const cutoff = new Date('2026-08-18T00:00:00.000Z');

    const deleted = await repo.deleteMessageLogsOlderThan(cutoff);

    expect(deleted).toBe(2);
    // Verify the SELECT query uses bounded batch with platform scope
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('SELECT id FROM message_logs'),
      ['messenger', cutoff, 1000],
    );
    // Verify the DELETE uses the returned IDs
    expect(deleteWhereMock).toHaveBeenCalledWith('id IN (:...ids)', {
      ids: [1, 2],
    });
  });

  it('returns 0 when no matching rows exist', async () => {
    const queryMock = jest.fn().mockResolvedValueOnce([]);
    const mappingRepo = {} as unknown as Repository<UserPlatformMappingEntity>;
    const logRepo = {
      query: queryMock,
      createQueryBuilder: jest.fn(),
    } as unknown as Repository<MessageLogEntity>;
    const repo = new MessengerRepository(mappingRepo, logRepo);

    const deleted = await repo.deleteMessageLogsOlderThan(new Date());

    expect(deleted).toBe(0);
    expect(logRepo.createQueryBuilder).not.toHaveBeenCalled();
  });
});

describe('MessengerRepository platform-scoped user lookups (#191)', () => {
  const buildRepoWithFindOne = (findOne: jest.Mock) => {
    const mappingRepo = {
      findOne,
      createQueryBuilder: jest.fn(),
      manager: { query: jest.fn() },
    } as unknown as Repository<UserPlatformMappingEntity>;
    const logRepo = {} as unknown as Repository<MessageLogEntity>;
    const repo = new MessengerRepository(mappingRepo, logRepo);
    return { repo };
  };

  it('scopes findActiveMappingByUserId to the messenger platform', async () => {
    const findOne = jest.fn().mockResolvedValue(null);
    const { repo } = buildRepoWithFindOne(findOne);

    await repo.findActiveMappingByUserId(143);

    expect(findOne).toHaveBeenCalledWith({
      where: { platform: 'messenger', userId: 143, status: 'ACTIVE' },
      order: { id: 'DESC' },
    });
  });

  it('returns null when only sibling-platform mappings exist for the userId', async () => {
    const findOne = jest.fn().mockResolvedValue(null);
    const { repo } = buildRepoWithFindOne(findOne);

    const result = await repo.findActiveMappingByUserId(143);

    expect(result).toBeNull();
  });

  it('returns the mapping when the userId has an active messenger row', async () => {
    const findOne = jest.fn().mockResolvedValue({
      id: 7,
      userId: 143,
      platform: 'messenger',
      externalUserId: 'psid-1',
      topic: 'ielts',
      cadence: 'WEEKLY',
      status: 'ACTIVE',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const { repo } = buildRepoWithFindOne(findOne);

    const result = await repo.findActiveMappingByUserId(143);

    expect(result?.psid).toBe('psid-1');
    expect(result?.userId).toBe(143);
  });

  const buildRepoWithQueryBuilder = () => {
    // Call sequence is shared across where/andWhere so the test can prove
    // the generated WHERE tree contains the consent predicate (#955).
    const whereCalls: Array<{
      kind: 'where' | 'andWhere';
      expression: string;
    }> = [];
    const builder: Record<string, unknown> = {};
    const track = (kind: 'where' | 'andWhere') =>
      jest.fn((expression: string) => {
        whereCalls.push({ kind, expression });
        return builder;
      });
    const where = track('where');
    const andWhere = track('andWhere');
    const orderBy = jest.fn().mockReturnThis();
    const take = jest.fn().mockReturnThis();
    const getMany = jest.fn().mockResolvedValue([]);
    const leftJoin = jest.fn().mockReturnThis();
    Object.assign(builder, {
      select: jest.fn().mockReturnThis(),
      leftJoin,
      where,
      andWhere,
      orderBy,
      take,
      getMany,
    });
    const createQueryBuilder = jest.fn().mockReturnValue(builder);
    const mappingRepo = {
      createQueryBuilder,
      findOne: jest.fn(),
      manager: { query: jest.fn() },
    } as unknown as Repository<UserPlatformMappingEntity>;
    const logRepo = {} as unknown as Repository<MessageLogEntity>;
    const repo = new MessengerRepository(mappingRepo, logRepo);
    return { repo, where, andWhere, leftJoin, whereCalls };
  };

  it('scopes findActiveSubscribedMappings to the messenger platform', async () => {
    const { repo, andWhere } = buildRepoWithQueryBuilder();

    await repo.findActiveSubscribedMappings();

    expect(andWhere).toHaveBeenCalledWith('mapping.platform = :platform', {
      platform: 'messenger',
    });
  });

  it('scopes findActiveSubscribedMappingsPage with keyset cursor', async () => {
    const { repo, andWhere } = buildRepoWithQueryBuilder();

    await repo.findActiveSubscribedMappingsPage(100, 500);

    expect(andWhere).toHaveBeenCalledWith('mapping.id > :afterId', {
      afterId: 100,
    });
    expect(andWhere).toHaveBeenCalledWith('mapping.platform = :platform', {
      platform: 'messenger',
    });
  });

  it('scopes findActiveMappingsPage to the messenger platform', async () => {
    const { repo, andWhere } = buildRepoWithQueryBuilder();

    await repo.findActiveMappingsPage(0, 100);

    expect(andWhere).toHaveBeenCalledWith('mapping.platform = :platform', {
      platform: 'messenger',
    });
  });

  it('filters reminders by consent — opt-out default keeps everyone (#596)', async () => {
    const { repo, where, leftJoin, whereCalls } = buildRepoWithQueryBuilder();

    await repo.findActiveMappingsPage(0, 100);

    expect(leftJoin).toHaveBeenCalledWith(
      'user_notification_preferences',
      'pref',
      'pref.user_id = mapping.user_id',
    );
    // The consent predicate opens the WHERE tree (#955 — where(), not
    // andWhere(), so no later call can replace it).
    expect(where).toHaveBeenCalledWith(
      'COALESCE(pref.reminder_enabled, true) = true',
    );
    expect(whereCalls[0]).toEqual({
      kind: 'where',
      expression: 'COALESCE(pref.reminder_enabled, true) = true',
    });
  });

  // #955 — the consent predicate must live inside the final WHERE tree.
  // TypeORM's `.where()` REPLACES any expression built so far, so the
  // consent filter is the `.where()` call and every other filter chains
  // with `.andWhere()` — exactly one `.where()` total, nothing replaces
  // the tree.
  it('keeps the reminder consent predicate inside the WHERE tree (#955)', async () => {
    const { repo, where, whereCalls } = buildRepoWithQueryBuilder();

    await repo.findActiveMappingsPage(0, 100);

    // Exactly one `.where()` — a second one would have replaced the tree.
    expect(where).toHaveBeenCalledTimes(1);
    expect(whereCalls.filter((call) => call.kind === 'where')).toHaveLength(1);

    // The consent predicate opens the tree.
    expect(whereCalls[0].kind).toBe('where');
    expect(whereCalls[0].expression).toContain('reminder_enabled');

    // The surviving tree keeps the active/platform/keyset filters too.
    for (const fragment of [
      'mapping.status',
      'mapping.platform',
      'mapping.id > :afterId',
    ]) {
      expect(
        whereCalls.some(
          (call) =>
            call.kind === 'andWhere' && call.expression.includes(fragment),
        ),
      ).toBe(true);
    }
  });
});

describe('MessengerRepository.logMessage (#262)', () => {
  it('persists message log metadata without messageText', async () => {
    const create = jest.fn().mockImplementation((payload) => ({
      id: 1,
      ...payload,
      createdAt: new Date('2026-08-20T10:00:00.000Z'),
    }));
    const save = jest
      .fn()
      .mockImplementation((entity) => Promise.resolve(entity));
    const mappingRepo = {} as unknown as Repository<UserPlatformMappingEntity>;
    const logRepo = {
      create,
      save,
    } as unknown as Repository<MessageLogEntity>;
    const repo = new MessengerRepository(mappingRepo, logRepo);

    const result = await repo.logMessage({
      userId: 143,
      psid: 'psid-123',
      messageType: 'FREE_FORM_CHAT_IN',
      status: 'SENT',
    });

    expect(create).toHaveBeenCalledWith({
      userId: 143,
      platform: 'messenger',
      externalUserId: 'psid-123',
      messageType: 'FREE_FORM_CHAT_IN',
      status: 'SENT',
      errorMessage: null,
    });
    expect(save).toHaveBeenCalled();
    expect(result).toEqual({
      id: 1,
      userId: 143,
      psid: 'psid-123',
      messageType: 'FREE_FORM_CHAT_IN',
      status: 'SENT',
      errorMessage: undefined,
      createdAt: '2026-08-20T10:00:00.000Z',
    });
    expect((result as Record<string, unknown>).messageText).toBeUndefined();
    expect(
      (create.mock.calls[0][0] as Record<string, unknown>).messageText,
    ).toBeUndefined();
  });
});
