import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { maskExternalId } from '@wispace/bot-common/masking';

/**
 * Per-feature scheduled-notification consent writes (#596), one row per
 * WISPACE userId. NULL column = feature default:
 * - `report_enabled` NULL   → opted OUT (reports are opt-in)
 * - `reminder_enabled` NULL → opted IN (reminders are opt-out)
 *
 * Reads are SQL filters inside the report crons and mapping readers; the
 * consent row itself is erased by `PrivacyDataService.delete()`.
 */
@Injectable()
export class NotificationPreferenceService {
  private readonly logger = new Logger(NotificationPreferenceService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async setReportEnabled(userId: number, enabled: boolean): Promise<void> {
    await this.setEnabled('report_enabled', userId, enabled);
  }

  async setReminderEnabled(userId: number, enabled: boolean): Promise<void> {
    await this.setEnabled('reminder_enabled', userId, enabled);
  }

  private async setEnabled(
    column: 'report_enabled' | 'reminder_enabled',
    userId: number,
    enabled: boolean,
  ): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO user_notification_preferences (user_id, ${column}, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET ${column} = $2, updated_at = now()`,
      [userId, enabled],
    );
    this.logger.log(
      `Set ${column}=${enabled} for userId=${maskExternalId(String(userId))}`,
    );
  }
}
