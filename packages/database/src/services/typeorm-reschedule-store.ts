import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { errorMessage } from '@wispace/bot-common';
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

  constructor(
    private readonly platform: string,
    @InjectRepository(RescheduleConfirmationEntity)
    private readonly repo: Repository<RescheduleConfirmationEntity>,
  ) {}

  async save(pending: PendingRescheduleRecord<TExternalId>): Promise<void> {
    const key = this.key(pending.externalId);
    try {
      await this.repo.query(
        `
        INSERT INTO reschedule_confirmations
          (external_id, user_id, calendar_id, scheduling_mode, new_local_date, new_time, session_label, status, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
        ON CONFLICT (external_id) DO UPDATE SET
          user_id = EXCLUDED.user_id,
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
          pending.userId,
          pending.calendarId,
          pending.schedulingMode,
          pending.newLocalDate ?? null,
          pending.newTime ?? null,
          pending.sessionLabel,
          new Date(pending.expiresAt),
        ],
      );
    } catch (error) {
      this.logger.warn(
        `Failed to save reschedule confirmation ${key}: ${errorMessage(error)}`,
      );
    }
  }

  async takeValid(
    externalId: TExternalId,
    userId?: number,
  ): Promise<PendingRescheduleRecord<TExternalId> | null> {
    const key = this.key(externalId);
    const rows: Array<Record<string, unknown>> = await this.repo.query(
      `
      UPDATE reschedule_confirmations
      SET status = 'processing', updated_at = now()
      WHERE external_id = $1
        AND status = 'pending'
        AND expires_at > now()
        ${userId != null ? 'AND user_id = $2' : ''}
      RETURNING *
    `,
      userId != null ? [key, userId] : [key],
    );

    if (rows.length === 0) {
      return null;
    }

    const row = rows[0];
    return this.mapRow(row);
  }

  async revertToPending(externalId: TExternalId): Promise<void> {
    await this.repo.query(
      `
      UPDATE reschedule_confirmations
      SET status = 'pending', expires_at = now() + interval '10 minutes', updated_at = now()
      WHERE external_id = $1 AND status = 'processing'
    `,
      [this.key(externalId)],
    );
  }

  async cancel(externalId: TExternalId): Promise<void> {
    await this.repo.delete({ externalId: this.key(externalId) });
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

  private mapRow(
    row: Record<string, unknown>,
  ): PendingRescheduleRecord<TExternalId> {
    const externalId = row.external_id;
    const schedulingMode = row.scheduling_mode;
    const sessionLabel = row.session_label;
    const expiresAt = row.expires_at;
    return {
      externalId:
        typeof externalId === 'string'
          ? (externalId as TExternalId)
          : ('' as TExternalId),
      userId: Number(row.user_id),
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
    };
  }
}
