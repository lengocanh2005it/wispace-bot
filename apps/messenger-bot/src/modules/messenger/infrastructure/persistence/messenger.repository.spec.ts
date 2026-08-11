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
    const mappingRepo = {
      manager: { query: managerQuery },
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn((input: Partial<UserPlatformMappingEntity>) => input),
      update: jest.fn(),
      createQueryBuilder: jest.fn(),
    } as unknown as Repository<UserPlatformMappingEntity>;
    const logRepo = {} as unknown as Repository<MessageLogEntity>;
    const claimRepo = {} as unknown as Repository<ScheduledReportClaimEntity>;
    const repo = new MessengerRepository(mappingRepo, logRepo, claimRepo);
    return { repo, managerQuery };
  };

  it('reactivates an INACTIVE row, then upserts atomically via ON CONFLICT', async () => {
    const { repo, managerQuery } = buildRepo();
    managerQuery
      .mockResolvedValueOnce([]) // UPDATE INACTIVE (no-op)
      .mockResolvedValueOnce([
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
});
