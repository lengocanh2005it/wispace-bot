import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { Platform } from '@wispace/contracts';
import type { PlatformLinkAuditEventType } from '../types';

/** Redacted ownership transition audit; external identifiers are hashed. */
@Entity('platform_link_audit_events')
@Index('idx_platform_link_audit_events_platform_created', [
  'platform',
  'createdAt',
])
@Index('idx_platform_link_audit_events_external_hash', [
  'platform',
  'externalUserHash',
  'eventType',
  'createdAt',
])
export class PlatformLinkAuditEventEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 16 })
  platform!: Platform;

  @Column({ name: 'external_user_hash', type: 'char', length: 64 })
  externalUserHash!: string;

  @Column({ name: 'mapping_generation', type: 'bigint', nullable: true })
  mappingGeneration!: string | null;

  @Column({ name: 'event_type', type: 'varchar', length: 32 })
  eventType!: PlatformLinkAuditEventType;

  @Column({ type: 'varchar', length: 160, nullable: true })
  reason!: string | null;

  @Column({
    name: 'ownership_version',
    type: 'varchar',
    length: 160,
    nullable: true,
  })
  ownershipVersion!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
