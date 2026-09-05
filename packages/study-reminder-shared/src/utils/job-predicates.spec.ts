import {
  studyReminderDispatchPredicateSql,
  studyReminderTerminalFailurePredicateSql,
  studyReminderTerminalRetentionPredicateSql,
} from './job-predicates';

describe('study-reminder job SQL predicates', () => {
  it('keeps dispatch eligibility scoped to retryable, unacknowledged jobs', () => {
    const sql = studyReminderDispatchPredicateSql('job');

    expect(sql).toContain("job.status = 'pending'");
    expect(sql).toContain("job.status = 'failed'");
    expect(sql).toContain('job.retry_count < job.max_retries');
    expect(sql).toContain("job.delivery_status = 'not_sent'");
    expect(sql).toContain('job.delivery_record IS NULL');
    expect(sql).not.toContain(
      "job.delivery_status IN ('ambiguous', 'rate_limited')",
    );
  });

  it('shares terminal delivery visibility across aliases', () => {
    const sql = studyReminderTerminalFailurePredicateSql('job');

    expect(sql).toContain(
      "job.delivery_status IN ('ambiguous', 'rate_limited')",
    );
    expect(studyReminderTerminalFailurePredicateSql()).toContain(
      "delivery_status IN ('ambiguous', 'rate_limited')",
    );
  });

  it('includes exhausted cancellations in retention visibility', () => {
    expect(studyReminderTerminalRetentionPredicateSql()).toContain(
      "status IN ('cancelled', 'failed')",
    );
  });
});
