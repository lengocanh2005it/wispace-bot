interface LearnerUsageQueryInput {
  externalUserId: string;
  platform: string;
  usageDate: string;
  userId: number;
}

interface LearnerUsageQuery {
  sql: string;
  params: unknown[];
}

/**
 * Build the database-owned scope for a learner's daily free-form quota.
 * Mapping table names belong here, at the persistence boundary, rather than
 * in the framework-agnostic metering package.
 */
export function buildLearnerUsageQuery(
  input: LearnerUsageQueryInput,
): LearnerUsageQuery {
  return {
    sql: `
      WITH active_links(platform, external_user_id, user_id) AS (
        SELECT 'messenger', external_user_id, user_id
        FROM user_platform_mappings
        WHERE status = 'ACTIVE' AND link_state = 'active'
        UNION ALL
        SELECT 'discord', external_user_id, user_id
        FROM discord_account_links
        WHERE link_state = 'active'
        UNION ALL
        SELECT 'zalo', external_user_id, user_id
        FROM zalo_account_links
        WHERE link_state = 'active'
      )
      SELECT COALESCE(SUM(usage.free_form_count), 0)::int AS used
      FROM chat_daily_usage usage
      WHERE usage.usage_date = $1::date
        AND (
          usage.user_id = $2
          OR (
            usage.user_id IS NULL
            AND usage.platform = $3
            AND usage.external_user_id = $4
          )
          OR (
            usage.user_id IS NULL
            AND EXISTS (
              SELECT 1
              FROM active_links link
              WHERE link.platform = usage.platform
                AND link.external_user_id = usage.external_user_id
                AND link.user_id = $2
            )
          )
        )
    `,
    params: [
      input.usageDate,
      input.userId,
      input.platform,
      input.externalUserId,
    ],
  };
}
