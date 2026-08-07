import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hoursFromNow } from '@wispace/date-utils';
import {
  OPS_HEALTH_REPOSITORY,
  type OpsHealthRepositoryPort,
  type OpsHealthAlert,
  type OpsHealthSnapshot,
} from './types';

const DEFAULT_FAILED_JOBS_HOURS = 24;
const DEFAULT_MIN_FAILED_JOBS = 1;
const DEFAULT_MIN_STUCK_RESERVED = 1;
const DEFAULT_MIN_STUCK_PROCESSING = 1;
const DEFAULT_LLM_SAFETY_THRESHOLD = 5;

@Injectable()
export class OpsHealthService {
  private readonly logger = new Logger(OpsHealthService.name);

  constructor(
    @Inject(OPS_HEALTH_REPOSITORY)
    private readonly repository: OpsHealthRepositoryPort,
    private readonly configService: ConfigService,
  ) {}

  isEnabled(): boolean {
    const raw = this.configService
      .get<string>('OPS_HEALTH_ALERT_ENABLED')
      ?.trim()
      .toLowerCase();
    return raw !== 'false' && raw !== '0';
  }

  async collectSnapshot(): Promise<OpsHealthSnapshot> {
    const now = new Date();
    const chatQuota = await this.repository.getChatQuotaSummary();
    const studyReminder = await this.repository.getStudyReminderSummary();

    const failedHours = this.getPositiveNumber(
      'OPS_ALERT_FAILED_JOBS_HOURS',
      DEFAULT_FAILED_JOBS_HOURS,
    );
    const failedSince = hoursFromNow(-failedHours);
    const llmSafetyWarnings =
      await this.repository.getLlmSafetyWarningsCount(failedSince);

    const threshold = this.getPositiveNumber(
      'LLM_SAFETY_WARNING_DAILY_THRESHOLD',
      DEFAULT_LLM_SAFETY_THRESHOLD,
    );

    const alerts = this.buildAlerts({
      chatQuota,
      studyReminder,
      llmSafetyWarnings,
    });

    return {
      generatedAt: now.toISOString(),
      alerts,
      chatQuota,
      studyReminder,
      llmSafetyWarnings24h: llmSafetyWarnings,
      llmSafetyThresholdBreached: llmSafetyWarnings >= threshold,
    };
  }

  async logSnapshotIfNeeded(): Promise<void> {
    if (!this.isEnabled()) return;

    const snapshot = await this.collectSnapshot();

    if (snapshot.alerts.length > 0) {
      for (const alert of snapshot.alerts) {
        this.logger.warn(
          `[OPS-HEALTH] ${alert.severity.toUpperCase()}: ${alert.code} — ${alert.message}`,
        );
      }
    } else {
      this.logger.log('[OPS-HEALTH] All checks passed');
    }
  }

  private buildAlerts(data: {
    chatQuota: Record<string, unknown>;
    studyReminder: Record<string, unknown>;
    llmSafetyWarnings: number;
  }): OpsHealthAlert[] {
    const alerts: OpsHealthAlert[] = [];

    const minFailedJobs = this.getPositiveNumber(
      'OPS_ALERT_MIN_FAILED_JOBS',
      DEFAULT_MIN_FAILED_JOBS,
    );
    const minStuckReserved = this.getPositiveNumber(
      'OPS_ALERT_MIN_STUCK_RESERVED',
      DEFAULT_MIN_STUCK_RESERVED,
    );
    const minStuckProcessing = this.getPositiveNumber(
      'OPS_ALERT_MIN_STUCK_PROCESSING',
      DEFAULT_MIN_STUCK_PROCESSING,
    );

    const terminalFailed =
      (data.studyReminder as Record<string, number>).terminalFailedSince ?? 0;
    if (terminalFailed >= minFailedJobs) {
      alerts.push({
        code: 'STUDY_REMINDER_TERMINAL_FAILED',
        severity: 'warn',
        message: `${terminalFailed} terminal failed study reminder job(s)`,
      });
    }

    const stuckProcessing =
      (data.studyReminder as Record<string, number>).stuckProcessing ?? 0;
    if (stuckProcessing >= minStuckProcessing) {
      alerts.push({
        code: 'STUDY_REMINDER_STUCK_PROCESSING',
        severity: 'warn',
        message: `${stuckProcessing} study reminder job(s) stuck in processing`,
      });
    }

    const stuckReserved =
      (data.chatQuota as Record<string, number>).stuckReserved ?? 0;
    if (stuckReserved >= minStuckReserved) {
      alerts.push({
        code: 'CHAT_QUOTA_STUCK_RESERVED',
        severity: 'warn',
        message: `${stuckReserved} stuck reserved idempotency row(s)`,
      });
    }

    const threshold = this.getPositiveNumber(
      'LLM_SAFETY_WARNING_DAILY_THRESHOLD',
      DEFAULT_LLM_SAFETY_THRESHOLD,
    );
    if (data.llmSafetyWarnings >= threshold) {
      alerts.push({
        code: 'LLM_SAFETY_WARNING_THRESHOLD',
        severity: 'warn',
        message: `${data.llmSafetyWarnings} LLM safety warning(s) in last 24h`,
      });
    }

    return alerts;
  }

  private getPositiveNumber(key: string, defaultValue: number): number {
    const raw = this.configService.get<string>(key)?.trim();
    if (!raw) return defaultValue;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : defaultValue;
  }
}
