import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { NotificationCadence } from '@messenger/modules/messenger/domain/entities/messenger.types';

@Index('idx_mapping_platform_ext_status', [
  'platform',
  'externalUserId',
  'status',
])
@Index('idx_mapping_user_status', ['userId', 'status'])
@Entity('user_platform_mappings')
export class UserPlatformMappingEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'user_id', type: 'int', nullable: true })
  userId: number | null;

  @Column({ type: 'varchar', length: 16, default: 'messenger' })
  platform: string;

  @Column({
    name: 'external_user_id',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  externalUserId: string | null;

  @Column({ name: 'notification_messages_token', type: 'text', unique: true })
  notificationMessagesToken: string;

  @Column({ type: 'varchar', length: 10, nullable: true })
  cadence: NotificationCadence | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  topic: string | null;

  @Column({ type: 'varchar', length: 10, default: 'ACTIVE' })
  status: 'ACTIVE' | 'INACTIVE';

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt: Date;
}
