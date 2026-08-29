import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import type {
  PendingRescheduleRecord,
  RescheduleStorePort,
} from '@wispace/reschedule-confirm';
import { RescheduleConfirmationEntity } from '../entities/reschedule-confirmation.entity';

/**
 * DB-backed reschedule confirmation store — pending confirmations survive
 * restarts and are visible to every pod. Keys are platform-scoped
 * (`messenger:psid`, `discord:uid`, `zalo:uid`).
 */
@Injectable()
export class TypeormRescheduleStore<
  TExternalId,
> implements RescheduleStorePort<TExternalId> {
  private readonly logger = new Logger(TypeormRescheduleStore.name);
  readonly requiresApprovalToken = true;

  constructor(
    private readonly platform: string,
    @InjectRepository(RescheduleConfirmationEntity)
    private readonly repo: Repository<RescheduleConfirmationEntity>,
  ) {}

  async save(pending: PendingRescheduleRecord<TExternalId>): Promise<void> {
    const key = this.key(pending.externalId);
    // Do NOT swallow — a failed persist must not report
    // pendingConfirmation: true while nothing was stored.
    await this.repo.query(
      `
        INSERT INTO reschedule_confirmations
          (external_id, tool_name, platform, user_id, mapping_version, intent_hash, args_hash, nonce, calendar_id, scheduling_mode, new_local_date, new_time, session_label, status, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending', $14)
        ON CONFLICT (external_id) DO UPDATE SET
          tool_name = EXCLUDED.tool_name,
          platform = EXCLUDED.platform,
          user_id = EXCLUDED.user_id,
          mapping_version = EXCLUDED.mapping_version,
          intent_hash = EXCLUDED.intent_hash,
          args_hash = EXCLUDED.args_hash,
          nonce = EXCLUDED.nonce,
          calendar_id = EXCLUDED.calendar_id,
          scheduling_mode = EXCLUDED.scheduling_mode,
          new_local_date = EXCLUDED.new_local_date,
          new_time = EXCLUDED.new_time,
          session_label = EXCLUDED.session_label,
          status = 'pending',
          expires_at = EXCLUDED.expires_at,
          updated_at = now()
      `,
      [
        key,
        pending.toolName ?? 'reschedule_study_session',
        pending.platform ?? this.platform,
        pending.userId,
        pending.mappingVersion ?? `legacy:${pending.userId}`,
        pending.intentHash ?? '',
        pending.argsHash ?? '',
        pending.nonce ?? randomUUID(),
        pending.calendarId,
        pending.schedulingMode,
        pending.newLocalDate ?? null,
        pending.newTime ?? null,
        pending.sessionLabel,
        new Date(pending.expiresAt),
      ],
    );
  }

  async takeValid(
    externalId: TExternalId,
    userId?: number,
    binding?: import('@wispace/reschedule-confirm').RescheduleApprovalBinding,
  ): Promise<PendingRescheduleRecord<TExternalId> | null> {
    const key = this.key(externalId);
    const leaseToken = randomUUID();
    const bindingConditions: string[] = [];
    const bindingParams: unknown[] = [];
    const addBinding = (column: string, value: unknown) => {
      if (value === undefined) return;
      bindingParams.push(value);
      bindingConditions.push(
        `${column} = $${bindingParams.length + (userId != null ? 3 : 2)}`,
      );
    };
    addBinding('platform', binding?.platform);
    addBinding('mapping_version', binding?.mappingVersion);
    addBinding('intent_hash', binding?.intentHash);
    addBinding('args_hash', binding?.argsHash);
    addBinding('nonce', binding?.nonce);
    const params = [
      key,
      leaseToken,
      ...(userId != null ? [userId] : []),
      ...bindingParams,
    ];
    const rows: Array<Record<string, unknown>> = await this.repo.query(
      `
      UPDATE reschedule_confirmations
      SET status = 'processing',
          lease_token = $2,
          processing_started_at = now(),
          updated_at = now()
      WHERE external_id = $1
        AND status = 'pending'
        AND expires_at > now()
        ${userId != null ? 'AND user_id = $3' : ''}
        ${bindingConditions.length ? `AND ${bindingConditions.join(' AND ')}` : ''}
      RETURNING *
    `,
      params,
    );

    if (rows.length === 0) {
      return null;
    }

    const row = rows[0];
    return this.mapRow(row);
  }

  async revertToPending(
    externalId: TExternalId,
    leaseToken?: string,
  ): Promise<void> {
    const conditions = ['external_id = $1', "status = 'processing'"];
    const params: unknown[] = [this.key(externalId)];
    if (leaseToken) {
      conditions.push('lease_token = $2');
      params.push(leaseToken);
    }
    await this.repo.query(
      `
      UPDATE reschedule_confirmations
      SET status = 'pending',
          lease_token = NULL,
          processing_started_at = NULL,
          expires_at = now() + interval '10 minutes',
          updated_at = now()
      WHERE ${conditions.join(' AND ')}
    `,
      params,
    );
  }

  async cancel(externalId: TExternalId, leaseToken?: string): Promise<void> {
    const conditions = ['external_id = $1'];
    const params: unknown[] = [this.key(externalId)];
    if (leaseToken) {
      // Ownership-gated: only cancel if we own the lease or row is not processing
      conditions.push(
        "(lease_token = $2 OR status IN ('pending', 'confirmed', 'cancelled'))",
      );
      params.push(leaseToken);
    } else {
      conditions.push(
        "lease_token IS NULL OR status IN ('pending', 'confirmed', 'cancelled')",
      );
    }
    await this.repo.query(
      `
      DELETE FROM reschedule_confirmations
      WHERE ${conditions.join(' AND ')}
    `,
      params,
    );
  }

  /**
   * Resets processing rows whose lease has expired back to pending.
   * Called by the recovery cron to handle crash-stranded confirmations.
   */
  async recoverStaleProcessing(staleAfterMs: number): Promise<number> {
    const result: Array<{ affected: number }> = await this.repo.query(
      `
      UPDATE reschedule_confirmations
      SET status = 'pending',
          lease_token = NULL,
          processing_started_at = NULL,
          expires_at = now() + interval '10 minutes',
          updated_at = now()
      WHERE status = 'processing'
        AND processing_started_at < now() - ($1::int * interval '1 millisecond')
        AND lease_token IS NOT NULL
    `,
      [staleAfterMs],
    );
    return result[0]?.affected ?? 0;
  }

  async hasPending(externalId: TExternalId): Promise<boolean> {
    const row = await this.repo.findOne({
      where: {
        externalId: this.key(externalId),
        status: 'pending',
      },
    });
    return !!row && row.expiresAt.getTime() > Date.now();
  }

  private key(externalId: TExternalId): string {
    return `${this.platform}:${String(externalId)}`;
  }

  /**
   * Strips the `${platform}:` prefix so the returned record carries the raw
   * external id — confirm() must hand the platform's own id to the reschedule
   * port, not the storage key.
   */
  private stripKeyPrefix(externalId: unknown): TExternalId {
    if (typeof externalId !== 'string') {
      return '' as TExternalId;
    }
    const prefix = `${this.platform}:`;
    return (
      externalId.startsWith(prefix)
        ? externalId.slice(prefix.length)
        : externalId
    ) as TExternalId;
  }

  private mapRow(
    row: Record<string, unknown>,
  ): PendingRescheduleRecord<TExternalId> {
    const externalId = row.external_id;
    const schedulingMode = row.scheduling_mode;
    const sessionLabel = row.session_label;
    const expiresAt = row.expires_at;
    return {
      externalId: this.stripKeyPrefix(externalId),
      toolName: typeof row.tool_name === 'string' ? row.tool_name : undefined,
      platform: typeof row.platform === 'string' ? row.platform : undefined,
      userId: Number(row.user_id),
      mappingVersion:
        typeof row.mapping_version === 'string'
          ? row.mapping_version
          : undefined,
      intentHash:
        typeof row.intent_hash === 'string' ? row.intent_hash : undefined,
      argsHash: typeof row.args_hash === 'string' ? row.args_hash : undefined,
      nonce: typeof row.nonce === 'string' ? row.nonce : undefined,
      calendarId: Number(row.calendar_id),
      schedulingMode:
        typeof schedulingMode === 'string'
          ? (schedulingMode as PendingRescheduleRecord<TExternalId>['schedulingMode'])
          : 'default_next_day_same_time',
      newLocalDate:
        typeof row.new_local_date === 'string' ? row.new_local_date : undefined,
      newTime: typeof row.new_time === 'string' ? row.new_time : undefined,
      sessionLabel: typeof sessionLabel === 'string' ? sessionLabel : '',
      expiresAt:
        typeof expiresAt === 'string' || expiresAt instanceof Date
          ? new Date(expiresAt).getTime()
          : 0,
      leaseToken:
        typeof row.lease_token === 'string' ? row.lease_token : undefined,
    };
  }
}
