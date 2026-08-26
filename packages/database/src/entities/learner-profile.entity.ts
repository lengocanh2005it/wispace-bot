import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Compact per-learner facts (band target, exam date) sourced ONLY from
 * server-derived tool results — the LLM never writes these fields (same
 * grounding principle as the study-reminder `scheduledTimeLabel`).
 * One row per (platform, external_user_id); per-field `fetched_at`
 * timestamps drive the freshness rules in `@wispace/learner-profile`.
 */
@Entity('learner_profiles')
export class LearnerProfileEntity {
  @PrimaryColumn({ type: 'varchar', length: 16 })
  platform!: string;

  @PrimaryColumn({ name: 'external_user_id', type: 'varchar', length: 128 })
  externalUserId!: string;

  /** WISPACE userId when the account is linked (nullable before linking). */
  @Column({ name: 'user_id', type: 'int', nullable: true })
  userId!: number | null;

  /** Band target (e.g. 7.0) — from `get_user_goals`. */
  @Column({ name: 'target_score', type: 'double precision', nullable: true })
  targetScore!: number | null;

  @Column({
    name: 'target_score_fetched_at',
    type: 'timestamptz',
    nullable: true,
  })
  targetScoreFetchedAt!: Date | null;

  /** Exam date `YYYY-MM-DD` — from `get_user_goals`. */
  @Column({ name: 'exam_date', type: 'varchar', length: 20, nullable: true })
  examDate!: string | null;

  @Column({ name: 'exam_date_fetched_at', type: 'timestamptz', nullable: true })
  examDateFetchedAt!: Date | null;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
