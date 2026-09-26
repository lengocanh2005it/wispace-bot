import {
  buildLearnerUsageQuery,
  buildLegacyLearnerUsageQuery,
} from './learner-usage-query';

describe('buildLearnerUsageQuery', () => {
  it('scopes the learner bucket to the rows owned by the WISPACE userId', () => {
    const query = buildLearnerUsageQuery({
      usageDate: '2026-08-18',
      userId: 143,
    });

    expect(query.sql).toContain('FROM chat_daily_usage');
    expect(query.sql).toContain('usage.user_id = $2');
    expect(query.params).toEqual(['2026-08-18', 143]);
  });

  it('never hydrates anonymous rows through active mappings (#1177)', () => {
    const query = buildLearnerUsageQuery({
      usageDate: '2026-08-18',
      userId: 143,
    });

    expect(query.sql).not.toContain('user_platform_mappings');
    expect(query.sql).not.toContain('discord_account_links');
    expect(query.sql).not.toContain('zalo_account_links');
    expect(query.sql).not.toContain('user_id IS NULL');
  });

  it('keeps the mapping-aware aggregate available only for the legacy rollout path', () => {
    const query = buildLegacyLearnerUsageQuery({
      externalUserId: 'ext-1',
      platform: 'messenger',
      usageDate: '2026-08-18',
      userId: 143,
    });

    expect(query.sql).toContain('user_platform_mappings');
    expect(query.sql).toContain('usage.user_id IS NULL');
    expect(query.params).toEqual(['2026-08-18', 143, 'messenger', 'ext-1']);
  });
});
