import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatQuotaOpsService } from '@messenger/modules/chat-rate-limit/application/services/chat-quota-ops.service';
import {
  STUDY_REMINDER_JOB_REPOSITORY,
  type StudyReminderJobRepositoryPort,
} from '@wispace/study-reminder-shared';
import { MESSENGER_MESSAGE_LOG_REPOSITORY } from '@messenger/modules/messenger/domain/repositories/messenger-message-log.repository.port';
import type { MessengerMessageLogRepositoryPort } from '@messenger/modules/messenger/domain/repositories/messenger-message-log.repository.port';
import { LlmSafetyService } from '@messenger/modules/llm-safety/llm-safety.service';
import type {
  OpsHealthAlert,
  OpsHealthSnapshot,
} from '../../domain/entities/ops-health.types';
import type { StudyReminderOpsSummary } from '@messenger/modules/study-reminder/domain/entities/study-reminder-ops.types';

@Injectable()
export class OpsHealthService {
  private readonly logger = new Logger(OpsHealthService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly chatQuotaOpsService: ChatQuotaOpsService,
    @Inject(STUDY_REMINDER_JOB_REPOSITORY)
    private readonly studyReminderJobRepository: StudyReminderJobRepositoryPort,
    @Inject(MESSENGER_MESSAGE_LOG_REPOSITORY)
    private readonly messageLogRepository: MessengerMessageLogRepositoryPort,
    private readonly llmSafetyService: LlmSafetyService,
  ) {}

  isAlertCronEnabled(): boolean {
    const raw = this.configService
      .get<string>('OPS_HEALTH_ALERT_ENABLED')
      ?.trim()
      .toLowerCase();

    if (!raw) {
      return true;
    }

    return raw === 'true' || raw === '1' || raw === 'yes';
  }

  async collectSnapshot(): Promise<OpsHealthSnapshot> {
    const failedHours = this.readPositiveNumber(
      'OPS_ALERT_FAILED_JOBS_HOURS',
      24,
    );
    const stuckProcessingMinutes = this.readPositiveNumber(
      'OPS_ALERT_STUCK_PROCESSING_MINUTES',
      10,
    );
    const denyLookbackHours = this.readPositiveNumber(
      'OPS_ALERT_DENY_LOOKBACK_HOURS',
      24,
    );
    const denySince = new Date(Date.now() - denyLookbackHours * 60 * 60 * 1000);

    const [
      chatQuotaBase,
      studyReminder,
      denyLogs24h,
      metaTokenExpiredEvents24h,
      llmSafetyWarnings24h,
    ] = await Promise.all([
      this.chatQuotaOpsService.getSummary(),
      this.collectStudyReminderSummary(failedHours, stuckProcessingMinutes),
      this.messageLogRepository.countMessageLogsByTypeSince(
        'CHAT_QUOTA_DENIED',
        denySince,
      ),
      this.messageLogRepository.countMessageLogsByTypeSince(
        'META_TOKEN_EXPIRED',
        denySince,
      ),
      this.llmSafetyService.countWarnings24h(),
    ]);

    const chatQuota = {
      ...chatQuotaBase,
      denyLogs24h,
    };

    const llmSafetyThreshold =
      this.llmSafetyService.readWarningDailyThreshold();
    const llmSafetyThresholdBreached =
      llmSafetyWarnings24h >= llmSafetyThreshold;

    const alerts = this.buildAlerts({
      chatQuota,
      studyReminder,
      metaTokenExpiredEvents24h,
      llmSafetyWarnings24h,
      llmSafetyThresholdBreached,
    });

    return {
      generatedAt: new Date().toISOString(),
      chatQuota,
      studyReminder,
      metaTokenExpiredEvents24h,
      llmSafetyWarnings24h,
      llmSafetyThresholdBreached,
      alerts,
    };
  }

  async logSnapshotIfNeeded(): Promise<OpsHealthSnapshot> {
    const snapshot = await this.collectSnapshot();

    if (snapshot.alerts.length > 0) {
      for (const alert of snapshot.alerts) {
        this.logger.warn(
          `OPS_HEALTH_ALERT code=${alert.code} ${alert.message}`,
        );
      }

      this.logger.warn(
        `OPS_HEALTH_SUMMARY alerts=${snapshot.alerts.length} studyTerminalFailed24h=${snapshot.studyReminder.terminalFailedSince} studyStuckProcessing=${snapshot.studyReminder.stuckProcessing} chatStuckReserved=${snapshot.chatQuota.stuckReserved} chatDenyLogs24h=${snapshot.chatQuota.denyLogs24h} metaTokenExpired24h=${snapshot.metaTokenExpiredEvents24h} llmSafetyWarnings24h=${snapshot.llmSafetyWarnings24h}`,
      );
    } else {
      this.logger.log(
        `OPS_HEALTH_OK studyTerminalFailed24h=${snapshot.studyReminder.terminalFailedSince} studyStuckProcessing=${snapshot.studyReminder.stuckProcessing} chatStuckReserved=${snapshot.chatQuota.stuckReserved} chatDenyLogs24h=${snapshot.chatQuota.denyLogs24h} metaTokenExpired24h=${snapshot.metaTokenExpiredEvents24h} llmSafetyWarnings24h=${snapshot.llmSafetyWarnings24h}`,
      );
    }

    return snapshot;
  }

  private buildAlerts(input: {
    chatQuota: OpsHealthSnapshot['chatQuota'];
    studyReminder: OpsHealthSnapshot['studyReminder'];
    metaTokenExpiredEvents24h: number;
    llmSafetyWarnings24h: number;
    llmSafetyThresholdBreached: boolean;
  }): OpsHealthAlert[] {
    const alerts: OpsHealthAlert[] = [];
    const minFailedJobs = this.readPositiveNumber(
      'OPS_ALERT_MIN_FAILED_JOBS',
      1,
    );
    const minStuckReserved = this.readPositiveNumber(
      'OPS_ALERT_MIN_STUCK_RESERVED',
      1,
    );
    const minStuckProcessing = this.readPositiveNumber(
      'OPS_ALERT_MIN_STUCK_PROCESSING',
      1,
    );

    if (input.studyReminder.terminalFailedSince >= minFailedJobs) {
      alerts.push({
        code: 'STUDY_REMINDER_TERMINAL_FAILED',
        severity: 'warn',
        message: `${input.studyReminder.terminalFailedSince} terminal failed job(s) in last ${input.studyReminder.failedHours}h`,
      });
    }

    if (input.studyReminder.stuckProcessing >= minStuckProcessing) {
      alerts.push({
        code: 'STUDY_REMINDER_STUCK_PROCESSING',
        severity: 'warn',
        message: `${input.studyReminder.stuckProcessing} job(s) stuck in processing > ${input.studyReminder.stuckProcessingMinutes}m`,
      });
    }

    if (input.chatQuota.stuckReserved >= minStuckReserved) {
      alerts.push({
        code: 'CHAT_QUOTA_STUCK_RESERVED',
        severity: 'warn',
        message: `${input.chatQuota.stuckReserved} idempotency row(s) stuck in reserved`,
      });
    }

    if (input.metaTokenExpiredEvents24h > 0) {
      alerts.push({
        code: 'META_TOKEN_EXPIRED',
        severity: 'warn',
        message: `PAGE_ACCESS_TOKEN may be expired — ${input.metaTokenExpiredEvents24h} send failure(s) in last ${this.readPositiveNumber('OPS_ALERT_DENY_LOOKBACK_HOURS', 24)}h; check ops runbook`,
      });
    }

    if (input.llmSafetyThresholdBreached) {
      alerts.push({
        code: 'LLM_SAFETY_WARNING_THRESHOLD',
        severity: 'warn',
        message: `LLM grounding warnings exceeded threshold — ${input.llmSafetyWarnings24h} event(s) in last 24h (threshold: ${this.llmSafetyService.readWarningDailyThreshold()})`,
      });
    }

    return alerts;
  }

  private async collectStudyReminderSummary(
    failedHours: number,
    stuckProcessingMinutes: number,
  ): Promise<StudyReminderOpsSummary> {
    const sampleLimit = 20;
    const failedSince = new Date(Date.now() - failedHours * 60 * 60 * 1000);
    const stuckBefore = new Date(
      Date.now() - stuckProcessingMinutes * 60 * 1000,
    );

    const [
      countsByStatus,
      terminalFailedSince,
      stuckProcessing,
      terminalFailedSamples,
      stuckProcessingSamples,
    ] = await Promise.all([
      this.studyReminderJobRepository.countJobsByStatus(),
      this.studyReminderJobRepository.countTerminalFailedSince(failedSince),
      this.studyReminderJobRepository.countStuckProcessing(stuckBefore),
      this.studyReminderJobRepository.findTerminalFailedSince(
        failedSince,
        sampleLimit,
      ),
      this.studyReminderJobRepository.findStuckProcessing(
        stuckBefore,
        sampleLimit,
      ),
    ]);

    return {
      countsByStatus,
      terminalFailedSince,
      stuckProcessing,
      failedHours,
      stuckProcessingMinutes,
      samples: {
        terminalFailed: terminalFailedSamples,
        stuckProcessing: stuckProcessingSamples,
      },
    };
  }

  private readPositiveNumber(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key)?.trim();
    if (!raw) {
      return fallback;
    }

    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      this.logger.warn(`${key} invalid; using fallback=${fallback}`);
      return fallback;
    }

    return Math.floor(value);
  }
}
