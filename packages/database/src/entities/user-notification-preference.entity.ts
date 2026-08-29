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

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
