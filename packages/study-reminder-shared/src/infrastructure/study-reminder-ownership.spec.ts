import type { Platform } from '@wispace/contracts';
import { cancelStudyReminderJobsForOwnershipChange } from './study-reminder-ownership';

describe('cancelStudyReminderJobsForOwnershipChange', () => {
  it.each(['messenger', 'discord', 'zalo'] as const)(
    'cancels an old-owner job before claim on %s',
    async (platform: Platform) => {
      const query = jest.fn().mockResolvedValue([{ id: 17 }]);

      const cancelled = await cancelStudyReminderJobsForOwnershipChange(
        { query },
        platform,
        `${platform}-user-1`,
        {
          generation: '2',
          reason: 'mapping_ownership_changed',
        },
      );

      expect(cancelled).toBe(1);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining(
          "status IN ('pending', 'processing', 'failed')",
        ),
        [platform, `${platform}-user-1`, '2', 'mapping_ownership_changed'],
      );
    },
  );
});
