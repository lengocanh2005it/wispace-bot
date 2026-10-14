import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RescheduleConfirmationAttemptEntity } from '@wispace/database';
import {
  MAX_NOTIFICATION_ATTEMPTS,
  notificationIsDue,
  type RescheduleAttemptRecord,
  type RescheduleAttemptStorePort,
  type RescheduleNotificationStatus,
} from '../reschedule-attempt.port';

/**
 * Postgres persistence for the durable reschedule attempt record (#1418).
 *
 * Every write is keyed by `(platform, external_id, nonce)` — the identity the
 * learner acted on — so a later request cannot overwrite an earlier's proof.
 *
 * #1507: the platform is bound at construction, like `TypeormRescheduleStore`.
 * The table is shared by all three bots under one advisory lock, so a scan that
 * did not filter by platform would hand the messenger transport a Discord id.
 */
@Injectable()
export class TypeormRescheduleAttemptStore implements RescheduleAttemptStorePort {
  constructor(
    private readonly platform: string,
    @InjectRepository(RescheduleConfirmationAttemptEntity)
    private readonly repo: Repository<RescheduleConfirmationAttemptEntity>,
  ) {}

  async beginAttempt(input: {
    externalId: string;
    nonce: string;
    userId: number;
  }): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .insert()
      .into(RescheduleConfirmationAttemptEntity)
      .values({
        platform: this.platform,
        externalId: input.externalId,
        nonce: input.nonce,
        userId: input.userId,
        status: 'attempting',
        notificationStatus: 'pending',
        notificationAttempts: 0,
      })
      .orUpdate(
        [
          'status',
          'notification_status',
          'notification_attempts',
          'updated_at',
        ],
        ['platform', 'external_id', 'nonce'],
      )
      .execute();
  }

  async confirmAttempt(input: {
    externalId: string;
    nonce: string;
    scheduledTimeLabel: string;
  }): Promise<boolean> {
    const result = await this.repo
      .createQueryBuilder()
      .update(RescheduleConfirmationAttemptEntity)
      .set({
        status: 'confirmed',
        scheduledTimeLabel: input.scheduledTimeLabel,
      })
      .where('external_id = :externalId', { externalId: input.externalId })
      .andWhere('nonce = :nonce', { nonce: input.nonce })
      .andWhere('status = :status', { status: 'attempting' })
      .andWhere('platform = :platform', { platform: this.platform })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async clearAttempt(externalId: string, nonce: string): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .delete()
      .from(RescheduleConfirmationAttemptEntity)
      .where('external_id = :externalId', { externalId })
      .andWhere('nonce = :nonce', { nonce })
      .andWhere('platform = :platform', { platform: this.platform })
      .execute();
  }

  async findAttempt(
    externalId: string,
    nonce: string,
  ): Promise<RescheduleAttemptRecord | null> {
    const row = await this.repo
      .createQueryBuilder('attempt')
      .where('attempt.external_id = :externalId', { externalId })
      .andWhere('attempt.nonce = :nonce', { nonce })
      .andWhere('attempt.platform = :platform', { platform: this.platform })
      .getOne();
    return row ? this.toRecord(row) : null;
  }

  async listDueNotificationAttempts(
    limit: number,
    now: Date,
  ): Promise<RescheduleAttemptRecord[]> {
    const rows = await this.repo
      .createQueryBuilder('attempt')
      .where('attempt.platform = :platform', { platform: this.platform })
      .andWhere('attempt.status = :status', { status: 'confirmed' })
      .andWhere('attempt.notification_status = :deferred', {
        deferred: 'deferred',
      })
      .andWhere('attempt.notification_attempts < :max', {
        max: MAX_NOTIFICATION_ATTEMPTS,
      })
      .andWhere(
        '(attempt.next_notification_attempt_at IS NULL OR attempt.next_notification_attempt_at <= :now)',
        { now },
      )
      .orderBy('attempt.next_notification_attempt_at', 'ASC')
      .limit(limit)
      .getMany();
    return rows
      .map((row) => this.toRecord(row))
      .filter((record) => notificationIsDue(record, now));
  }

  async markNotificationDelivered(
    externalId: string,
    nonce: string,
  ): Promise<void> {
    await this.bumpNotification(externalId, nonce, 'delivered', null);
  }

  async markNotificationAmbiguous(
    externalId: string,
    nonce: string,
  ): Promise<void> {
    await this.bumpNotification(externalId, nonce, 'ambiguous', null);
  }

  async deferNotification(
    externalId: string,
    nonce: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    await this.bumpNotification(externalId, nonce, 'deferred', nextAttemptAt);
  }

  async markNotificationAbandoned(
    externalId: string,
    nonce: string,
  ): Promise<void> {
    await this.bumpNotification(externalId, nonce, 'abandoned', null);
  }

  /**
   * The notification is a property of one attempt row, so the update is scoped
   * by its identity and bumps the attempt counter in the same statement.
   */
  private async bumpNotification(
    externalId: string,
    nonce: string,
    status: RescheduleNotificationStatus,
    nextAttemptAt: Date | null,
  ): Promise<void> {
    const record = await this.findAttempt(externalId, nonce);
    if (!record) {
      return;
    }
    await this.repo
      .createQueryBuilder()
      .update(RescheduleConfirmationAttemptEntity)
      .set({
        notificationStatus: status,
        notificationAttempts: record.notificationAttempts + 1,
        nextNotificationAttemptAt: nextAttemptAt,
      })
      .where('external_id = :externalId', { externalId })
      .andWhere('nonce = :nonce', { nonce })
      .andWhere('platform = :platform', { platform: this.platform })
      .execute();
  }

  private toRecord(
    row: RescheduleConfirmationAttemptEntity,
  ): RescheduleAttemptRecord {
    return {
      externalId: row.externalId,
      nonce: row.nonce,
      platform: row.platform,
      userId: row.userId,
      status: row.status,
      scheduledTimeLabel: row.scheduledTimeLabel,
      notificationStatus: row.notificationStatus,
      notificationAttempts: row.notificationAttempts,
      nextNotificationAttemptAt: row.nextNotificationAttemptAt,
    };
  }
}
