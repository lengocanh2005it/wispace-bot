import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Lease-based cron leader election — a configured leader that dies must not
 * leave the 08:00 report cron permanently dead. Each pod heartbeats its lease
 * every minute; when a lease expires, any other pod can take it over.
 */
@Entity('cron_leader_leases')
export class CronLeaderLeaseEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  name: string;

  @Column({ name: 'instance_id', type: 'varchar', length: 128 })
  instanceId: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
