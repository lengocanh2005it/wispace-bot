import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('message_logs')
export class DiscordMessageLogEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 16, default: 'discord' })
  platform!: string;

  @Column({ type: 'varchar', length: 64, name: 'external_user_id' })
  externalUserId!: string;

  @Column({ type: 'varchar', length: 20 })
  status!: string;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  error!: string | null;

  @Column({
    name: 'message_type',
    type: 'varchar',
    length: 50,
    default: 'chat',
  })
  messageType!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
