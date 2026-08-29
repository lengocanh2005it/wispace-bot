import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * One row per WISPACE userId. `last_active_at` is the max web-app activity
 * timestamp seen so far (merged with GREATEST on every webhook), so duplicate
 * and out-of-order deliveries are harmless — no idempotency key needed.
 * Self-updating; only grows one row per linked learner; no cleanup cron.
 */
@Entity('web_activity')
export class WebActivityEntity {
  @PrimaryColumn({ name: 'user_id', type: 'int' })
  userId!: number;

  @Column({ name: 'last_active_at', type: 'timestamptz' })
  lastActiveAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
