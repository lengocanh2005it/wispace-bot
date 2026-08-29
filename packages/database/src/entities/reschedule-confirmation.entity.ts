import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Persisted reschedule confirmations — survives restarts and multi-pod
 * deployments (the old per-instance Map lost pending confirmations whenever
 * the webhook landed on another pod).
 */
@Entity('reschedule_confirmations')
@Index('idx_reschedule_confirm_external_status', ['externalId', 'status'])
export class RescheduleConfirmationEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  /** Platform-scoped key, e.g. `messenger:psid`, `discord:uid`, `zalo:uid`. */
  @Column({ name: 'external_id', type: 'varchar', length: 128 })
  externalId!: string;

  @Column({ name: 'tool_name', type: 'varchar', length: 64 })
  toolName!: string;

  @Column({ name: 'platform', type: 'varchar', length: 16 })
  platform!: string;

  @Column({ name: 'user_id', type: 'int' })
  userId!: number;

  @Column({ name: 'mapping_version', type: 'varchar', length: 255 })
  mappingVersion!: string;

  @Column({ name: 'intent_hash', type: 'varchar', length: 64 })
  intentHash!: string;

  @Column({ name: 'args_hash', type: 'varchar', length: 64 })
  argsHash!: string;

  @Column({ name: 'nonce', type: 'uuid' })
  nonce!: string;

  @Column({ name: 'calendar_id', type: 'int' })
  calendarId!: number;

  @Column({ name: 'scheduling_mode', type: 'varchar', length: 32 })
  schedulingMode!: string;

  @Column({
    name: 'new_local_date',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  newLocalDate!: string | null;

  @Column({ name: 'new_time', type: 'varchar', length: 10, nullable: true })
  newTime!: string | null;

  @Column({ name: 'session_label', type: 'varchar', length: 255 })
  sessionLabel!: string;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: 'pending' | 'processing' | 'confirmed' | 'cancelled';

  @Column({ name: 'lease_token', type: 'uuid', nullable: true })
  leaseToken!: string | null;

  @Column({
    name: 'processing_started_at',
    type: 'timestamptz',
    nullable: true,
  })
  processingStartedAt!: Date | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
