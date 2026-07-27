import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('webhook_dead_letters')
export class WebhookDeadLetterEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 16, default: 'messenger' })
  platform!: string;

  @Column({
    type: 'varchar',
    length: 64,
    nullable: true,
    name: 'external_user_id',
  })
  externalUserId!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'message_mid' })
  messageMid!: string | null;

  @Column({ type: 'jsonb', name: 'raw_payload' })
  rawPayload!: unknown;

  @Column({ type: 'text', name: 'error_message', default: '' })
  errorMessage!: string;

  @Column({ type: 'int', name: 'retry_count', default: 0 })
  retryCount!: number;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: string;

  @Column({ type: 'timestamptz', nullable: true, name: 'replayed_at' })
  replayedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
