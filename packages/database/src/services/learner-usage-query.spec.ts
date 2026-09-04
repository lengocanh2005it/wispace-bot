import { buildLearnerUsageQuery } from './learner-usage-query';

describe('buildLearnerUsageQuery', () => {
  it('keeps the learner scope in the database boundary', () => {
    const query = buildLearnerUsageQuery({
      externalUserId: 'channel-1',
      platform: 'discord',
      usageDate: '2026-08-18',
      userId: 143,
    });

    expect(query.sql).toContain('user_platform_mappings');
    expect(query.sql).toContain('discord_account_links');
    expect(query.sql).toContain('zalo_account_links');
    expect(query.params).toEqual(['2026-08-18', 143, 'discord', 'channel-1']);
  });
});
