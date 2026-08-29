import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { Platform } from '@wispace/contracts';

/**
 * Stores explicit learner notification channel preference (Messenger, Discord, Zalo).
 * One row per WISPACE userId. When unset, delivery resolves using deterministic
 * fallback priority: Zalo > Discord > Messenger.
 */
@Entity('user_notification_preferences')
export class UserNotificationPreferenceEntity {
  @PrimaryColumn({ name: 'user_id', type: 'int' })
  userId!: number;

  @Column({
    name: 'preferred_platform',
    type: 'varchar',
    length: 16,
    nullable: true,
  })
  preferredPlatform!: Platform | null;

  /**
   * Explicit consent for scheduled learning reports (#596).
   * NULL = opted out (reports are opt-in).
   */
  @Column({ name: 'report_enabled', type: 'boolean', nullable: true })
  reportEnabled!: boolean | null;

  /**
   * Explicit consent for study session reminders (#596).
   * NULL = opted in (reminders are opt-out — they mirror the learner's own calendar).
   */
  @Column({ name: 'reminder_enabled', type: 'boolean', nullable: true })
  reminderEnabled!: boolean | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
