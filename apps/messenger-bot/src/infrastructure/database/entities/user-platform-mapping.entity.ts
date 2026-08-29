import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { NotificationCadence } from '@messenger/modules/messenger/domain/entities/messenger.types';
import type { PlatformLinkState } from '@wispace/contracts';

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

  @Column({
    name: 'link_state',
    type: 'varchar',
    length: 24,
    default: 'active',
  })
  linkState: PlatformLinkState;

  @Column({ name: 'mapping_generation', type: 'bigint', default: 1 })
  mappingGeneration: string;

  @Column({ name: 'last_verified_at', type: 'timestamptz', nullable: true })
  lastVerifiedAt: Date | null;

  @Column({ name: 'last_unknown_at', type: 'timestamptz', nullable: true })
  lastUnknownAt: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({
    name: 'revocation_reason',
    type: 'varchar',
    length: 160,
    nullable: true,
  })
  revocationReason: string | null;

  @Column({
    name: 'upstream_ownership_version',
    type: 'varchar',
    length: 160,
    nullable: true,
  })
  upstreamOwnershipVersion: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt: Date;
}
