import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { addHours } from 'date-fns';
import {
  OPS_HEALTH_REPOSITORY,
  type OpsHealthRepositoryPort,
  type OpsHealthAlert,
  type OpsHealthSnapshot,
  type ApplicationReadinessResult,
  type OpsHealthServicePort,
  type RedisHealthPort,
  CRON_HEARTBEAT_REGISTRY,
} from './types';
import { CronHeartbeatRegistry } from './cron-heartbeat-registry';

const DEFAULT_FAILED_JOBS_HOURS = 24;
const DEFAULT_MIN_FAILED_JOBS = 1;
const DEFAULT_MIN_STUCK_RESERVED = 1;
const DEFAULT_MIN_STUCK_PROCESSING = 1;
const DEFAULT_LLM_SAFETY_THRESHOLD = 5;
const DEFAULT_MAX_WEBHOOK_AGE_SECONDS = 600;
const DEFAULT_MAX_WEBHOOK_BACKLOG = 20;
const DEFAULT_MAX_DEAD_LETTER_BACKLOG = 5;

@Injectable()
export class OpsHealthService implements OpsHealthServicePort {
  private readonly logger = new Logger(OpsHealthService.name);

  constructor(
    @Inject(OPS_HEALTH_REPOSITORY)
    private readonly repository: OpsHealthRepositoryPort,
    private readonly configService: ConfigService,
    @Optional()
    @Inject(CRON_HEARTBEAT_REGISTRY)
    private readonly cronHeartbeatRegistry?: CronHeartbeatRegistry,
    @Optional()
    @Inject('REDIS_HEALTH_CLIENT')
    private readonly redisClient?: RedisHealthPort,
  ) {}

  isEnabled(): boolean {
    const raw = this.configService
      .get<string>('OPS_HEALTH_ALERT_ENABLED')
      ?.trim()
      .toLowerCase();
    return raw !== 'false' && raw !== '0';
  }

  async isApplicationReady(): Promise<ApplicationReadinessResult> {
    if (this.repository.isDatabaseReachable) {
      const isDbOk = await this.repository.isDatabaseReachable();
      if (!isDbOk) {
        return {
          ready: false,
          status: 'error',
          reason: 'database_unavailable',
        };
      }
    }

    if (this.redisClient) {
      if (this.redisClient.isConfiguredEnabled()) {
        if (!this.redisClient.isEnabled()) {
          return {
            ready: false,
            status: 'error',
            reason: 'redis_configured_not_connected',
          };
        }
        try {
          const pong = await this.redisClient.ping();
          if (pong !== 'PONG') {
            return {
              ready: false,
              status: 'error',
              reason: 'redis_ping_failed',
            };
          }
        } catch {
          return {
            ready: false,
            status: 'error',
            reason: 'redis_unreachable',
          };
        }
      }
    }

    if (this.repository.getWebhookInboundSummary) {
      try {
        const webhook = await this.repository.getWebhookInboundSummary();
        const maxAge = this.getPositiveNumber(
          'OPS_READY_MAX_WEBHOOK_AGE_SECONDS',
          DEFAULT_MAX_WEBHOOK_AGE_SECONDS,
        );
        if (
          webhook.oldestPendingAgeSeconds !== null &&
          webhook.oldestPendingAgeSeconds > maxAge
        ) {
          return {
            ready: false,
            status: 'error',
            reason: `webhook_inbound_stuck_age_${webhook.oldestPendingAgeSeconds}s`,
          };
        }
      } catch (err) {
        this.logger.warn(
          `Failed to inspect webhook queue for readiness: ${String(err)}`,
        );
      }
    }

    return { ready: true, status: 'ok' };
  }

  async collectSnapshot(): Promise<OpsHealthSnapshot> {
    const now = new Date();

    const failedHours = this.getPositiveNumber(
      'OPS_ALERT_FAILED_JOBS_HOURS',
      DEFAULT_FAILED_JOBS_HOURS,
    );
    const failedSince = addHours(new Date(), -failedHours);

    let databaseStatus: 'connected' | 'disconnected' | 'unknown' = 'unknown';
    if (this.repository.isDatabaseReachable) {
      databaseStatus = (await this.repository.isDatabaseReachable())
        ? 'connected'
        : 'disconnected';
    }

    let redisStatus:
      | 'connected'
      | 'disabled'
      | 'error'
      | 'unreachable'
      | 'unknown' = 'unknown';
    if (this.redisClient) {
      if (!this.redisClient.isConfiguredEnabled()) {
        redisStatus = 'disabled';
      } else if (!this.redisClient.isEnabled()) {
        redisStatus = 'error';
      } else {
        try {
          const pong = await this.redisClient.ping();
          redisStatus = pong === 'PONG' ? 'connected' : 'error';
        } catch {
          redisStatus = 'unreachable';
        }
      }
    }

    const [
      chatQuota,
      studyReminder,
      webhookInbound,
      deadLetter,
      llmSafetyWarnings,
    ] = await Promise.all([
      this.repository.getChatQuotaSummary(),
      this.repository.getStudyReminderSummary(),
      this.repository.getWebhookInboundSummary
        ? this.repository.getWebhookInboundSummary()
        : Promise.resolve(undefined),
      this.repository.getDeadLetterSummary
        ? this.repository.getDeadLetterSummary()
        : Promise.resolve(undefined),
      this.repository.getLlmSafetyWarningsCount(failedSince),
    ]);

    const crons = this.cronHeartbeatRegistry
      ? this.cronHeartbeatRegistry.getRegisteredCrons()
      : {};

    const threshold = this.getPositiveNumber(
      'LLM_SAFETY_WARNING_DAILY_THRESHOLD',
      DEFAULT_LLM_SAFETY_THRESHOLD,
    );
    const safetyThresholdBreached = llmSafetyWarnings >= threshold;

    const alerts = this.buildAlerts({
      databaseStatus,
      redisStatus,
      chatQuota,
      studyReminder,
      webhookInbound,
      deadLetter,
      llmSafetyWarnings,
      safetyThresholdBreached,
      crons,
    });

    const hasCritical =
      alerts.some((a) => a.severity === 'critical') ||
      databaseStatus === 'disconnected' ||
      redisStatus === 'unreachable' ||
      redisStatus === 'error';

    const hasWarn =
      alerts.some((a) => a.severity === 'warn') || safetyThresholdBreached;

    const status: 'ok' | 'degraded' | 'error' = hasCritical
      ? 'error'
      : hasWarn
        ? 'degraded'
        : 'ok';

    return {
      generatedAt: now.toISOString(),
      status,
      infrastructure: {
        database: databaseStatus,
        redis: redisStatus,
      },
      queues: {
        webhookInbound,
        deadLetter,
        chatQuota,
        studyReminder,
      },
      crons,
      llm: {
        safetyWarnings24h: llmSafetyWarnings,
        safetyThresholdBreached,
      },
      alerts,
      chatQuota,
      studyReminder,
      llmSafetyWarnings24h: llmSafetyWarnings,
      llmSafetyThresholdBreached: safetyThresholdBreached,
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
    databaseStatus: string;
    redisStatus: string;
    chatQuota: Record<string, unknown>;
    studyReminder: Record<string, unknown>;
    webhookInbound?: { pendingCount: number; failedCount: number };
    deadLetter?: { outboundPendingCount: number; outboundFailedCount: number };
    llmSafetyWarnings: number;
    safetyThresholdBreached: boolean;
    crons: Record<string, { status: string; name: string }>;
  }): OpsHealthAlert[] {
    const alerts: OpsHealthAlert[] = [];

    if (data.databaseStatus === 'disconnected') {
      alerts.push({
        code: 'DATABASE_DISCONNECTED',
        severity: 'critical',
        message: 'Database connection failed',
      });
    }

    if (data.redisStatus === 'unreachable' || data.redisStatus === 'error') {
      alerts.push({
        code: 'REDIS_UNREACHABLE',
        severity: 'critical',
        message: `Redis is unreachable or not connected (status: ${data.redisStatus})`,
      });
    }

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

    if (data.safetyThresholdBreached) {
      alerts.push({
        code: 'LLM_SAFETY_WARNING_THRESHOLD',
        severity: 'warn',
        message: `${data.llmSafetyWarnings} LLM safety warning(s) in last 24h`,
      });
    }

    const maxWebhookBacklog = this.getPositiveNumber(
      'OPS_ALERT_MAX_WEBHOOK_BACKLOG',
      DEFAULT_MAX_WEBHOOK_BACKLOG,
    );
    if (
      data.webhookInbound &&
      data.webhookInbound.pendingCount > maxWebhookBacklog
    ) {
      alerts.push({
        code: 'WEBHOOK_INBOUND_BACKLOG_HIGH',
        severity: 'warn',
        message: `${data.webhookInbound.pendingCount} pending webhook inbound event(s)`,
      });
    }

    const maxDeadLetter = this.getPositiveNumber(
      'OPS_ALERT_MAX_DEAD_LETTER_BACKLOG',
      DEFAULT_MAX_DEAD_LETTER_BACKLOG,
    );
    if (
      data.deadLetter &&
      data.deadLetter.outboundPendingCount > maxDeadLetter
    ) {
      alerts.push({
        code: 'DEAD_LETTER_BACKLOG_HIGH',
        severity: 'warn',
        message: `${data.deadLetter.outboundPendingCount} outbound dead letter(s) pending retry`,
      });
    }

    for (const cron of Object.values(data.crons)) {
      if (cron.status === 'stale') {
        alerts.push({
          code: 'CRON_EXECUTION_STALE',
          severity: 'warn',
          message: `Cron job '${cron.name}' is stale (missed expected execution interval)`,
        });
      }
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
