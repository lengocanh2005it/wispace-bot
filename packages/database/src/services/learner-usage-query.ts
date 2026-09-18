interface LearnerUsageQueryInput {
  usageDate: string;
  userId: number;
}

interface LearnerUsageQuery {
  sql: string;
  params: unknown[];
}

/**
 * Build the database-owned scope for a learner's daily free-form quota.
 *
 * The learner bucket is exactly the rows owned by the WISPACE `userId`, summed
 * across platforms. Anonymous rows are never hydrated into it, even when an
 * active mapping points at the learner: linking, unlinking, and relinking must
 * not move usage between the learner bucket and an anonymous bucket
 * (ADR-0027 / #1177).
 */
export function buildLearnerUsageQuery(
  input: LearnerUsageQueryInput,
): LearnerUsageQuery {
  return {
    sql: `
      SELECT COALESCE(SUM(usage.free_form_count), 0)::int AS used
      FROM chat_daily_usage usage
      WHERE usage.usage_date = $1::date
        AND usage.user_id = $2
    `,
    params: [input.usageDate, input.userId],
  };
}
