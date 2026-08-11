import { Repository } from 'typeorm';
import { buildPocPsidToken } from '@messenger/shared/config/poc.constants';
import {
  MessageLogEntity,
  ScheduledReportClaimEntity,
  UserPlatformMappingEntity,
} from '@messenger/infrastructure/database/entities';
import { MessengerRepository } from './messenger.repository';

describe('MessengerRepository.upsertPsidUserLink', () => {
  const buildRepo = () => {
    const managerQuery = jest.fn();
    const findOneMock = jest.fn();
    const saveMock = jest.fn();
    const mappingRepo = {
      manager: { query: managerQuery },
      findOne: findOneMock,
      save: saveMock,
      create: jest.fn((input: Partial<UserPlatformMappingEntity>) => input),
      update: jest.fn(),
      createQueryBuilder: jest.fn(),
    } as unknown as Repository<UserPlatformMappingEntity>;
    const logRepo = {} as unknown as Repository<MessageLogEntity>;
    const claimRepo = {} as unknown as Repository<ScheduledReportClaimEntity>;
    const repo = new MessengerRepository(mappingRepo, logRepo, claimRepo);
    return { repo, managerQuery, findOneMock, saveMock };
  };

  it('upserts atomically via ON CONFLICT when an ACTIVE row exists', async () => {
    const { repo, managerQuery, findOneMock } = buildRepo();
    managerQuery.mockResolvedValue([
      {
        id: 7,
        user_id: 143,
        platform: 'messenger',
        external_user_id: 'psid-1',
        notification_messages_token: buildPocPsidToken('psid-1'),
        topic: 'ielts',
        cadence: 'weekly',
        status: 'ACTIVE',
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);

    const result = await repo.upsertPsidUserLink({
      psid: 'psid-1',
      userId: 143,
      topic: 'ielts',
      cadence: 'weekly',
    });

    expect(result.psid).toBe('psid-1');
    expect(result.userId).toBe(143);
    expect(managerQuery).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (external_user_id)'),
      expect.any(Array),
    );
    expect(findOneMock).not.toHaveBeenCalled();
  });

  it('re-activates an INACTIVE mapping when no ACTIVE row exists', async () => {
    const { repo, managerQuery, findOneMock, saveMock } = buildRepo();
    managerQuery.mockResolvedValue([]);
    findOneMock.mockResolvedValue({
      id: 3,
      userId: 100,
      platform: 'messenger',
      externalUserId: 'psid-1',
      notificationMessagesToken: 'old-token',
      topic: null,
      cadence: null,
      status: 'INACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    saveMock.mockImplementation((entity: UserPlatformMappingEntity) =>
      Promise.resolve(entity),
    );

    const result = await repo.upsertPsidUserLink({
      psid: 'psid-1',
      userId: 143,
    });

    expect(result.userId).toBe(143);
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 3, status: 'ACTIVE' }),
    );
  });
});
