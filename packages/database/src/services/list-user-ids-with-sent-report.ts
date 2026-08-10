import { Repository } from 'typeorm';
import { ScheduledReportClaimEntity } from '../entities/scheduled-report-claim.entity';

/**
 * All userIds with a 'sent' claim for the date — lets report crons skip the
 * per-user "already sent today" check. Shared by every bot repository that
 * implements `ReportClaimRepositoryPort`.
 */
export async function listUserIdsWithSentReport(
  repo: Repository<ScheduledReportClaimEntity>,
  reportDate: string,
): Promise<number[]> {
  const rows = await repo.find({
    select: { userId: true },
    where: { reportDate, status: 'sent' },
  });
  return rows
    .map((row) => row.userId)
    .filter((userId): userId is number => userId !== null);
}
