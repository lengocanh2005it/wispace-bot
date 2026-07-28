import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('zalo_message_logs')
export class ZaloMessageLogEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 64, name: 'external_user_id' })
  externalUserId!: string;

  @Column({ type: 'varchar', length: 20 })
  status!: string;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ type: 'varchar', length: 50, default: 'chat' })
  messageType!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
