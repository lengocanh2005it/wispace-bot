import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Durable record of a reschedule whose calendar mutation was attempted (#1418).
 *
 * The staged request cannot hold this: it is a single slot per learner and its
 * save path overwrites whatever is there. This table is append-only and keyed by
 * the approval token the learner acted on, so a later request can never destroy
 * an earlier one's proof — and so a replay can tell "already committed" from
 * "never made" from "outcome unknown".
 *
 * See `CONTEXT.md` — *committed confirmation* and *unknown-outcome attempt*.
 */
@Entity('reschedule_confirmation_attempts')
@Index(
  'idx_reschedule_attempt_identity_unique',
  ['platform', 'externalId', 'nonce'],
  {
    unique: true,
  },
)
@Index('idx_reschedule_attempt_notification_due', [
  'status',
  'notificationStatus',
  'nextNotificationAttemptAt',
])
export class RescheduleConfirmationAttemptEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'platform', type: 'varchar', length: 16 })
  platform!: string;

  @Column({ name: 'external_id', type: 'varchar', length: 128 })
  externalId!: string;

  /** The approval token carried by the button the learner tapped. */
  @Column({ name: 'nonce', type: 'uuid' })
  nonce!: string;

  @Column({ name: 'user_id', type: 'int' })
  userId!: number;

  @Column({ type: 'varchar', length: 16, default: 'attempting' })
  status!: 'attempting' | 'confirmed';

  /** Server-rendered label of the new session time, for replayed confirmations. */
  @Column({
    name: 'scheduled_time_label',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  scheduledTimeLabel!: string | null;

  @Column({
    name: 'notification_status',
    type: 'varchar',
    length: 16,
    default: 'pending',
  })
  notificationStatus!:
    | 'pending'
    | 'deferred'
    | 'delivered'
    | 'ambiguous'
    | 'abandoned';

  @Column({ name: 'notification_attempts', type: 'int', default: 0 })
  notificationAttempts!: number;

  @Column({
    name: 'next_notification_attempt_at',
    type: 'timestamptz',
    nullable: true,
  })
  nextNotificationAttemptAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
