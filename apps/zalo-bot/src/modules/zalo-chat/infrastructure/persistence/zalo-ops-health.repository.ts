import { Injectable } from '@nestjs/common';
import type { OpsHealthRepositoryPort } from '@wispace/ops-health';

@Injectable()
export class ZaloOpsHealthRepository implements OpsHealthRepositoryPort {
  getChatQuotaSummary(): Promise<Record<string, unknown>> {
    return Promise.resolve({
      denyLogs24h: 0,
      stuckReserved: 0,
      usersAtDailyLimit: 0,
    });
  }

  getStudyReminderSummary(): Promise<Record<string, unknown>> {
    return Promise.resolve({
      countsByStatus: {},
      terminalFailedSince: 0,
      stuckProcessing: 0,
    });
  }

  getLlmSafetyWarningsCount(): Promise<number> {
    return Promise.resolve(0);
  }
}
