import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Learner profiles (#207 item 3): compact per-learner facts (band target,
 * exam date) persisted from server-derived tool results and injected into
 * the chat system prompt with freshness rules.
 */
export class CreateLearnerProfiles1786854137301 implements MigrationInterface {
  name = 'CreateLearnerProfiles1786854137301';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "learner_profiles" (
        "platform" varchar(16) NOT NULL,
        "external_user_id" varchar(128) NOT NULL,
        "user_id" integer,
        "target_score" double precision,
        "target_score_fetched_at" timestamptz,
        "exam_date" varchar(20),
        "exam_date_fetched_at" timestamptz,
        "updated_at" timestamptz NOT NULL,
        PRIMARY KEY ("platform", "external_user_id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "learner_profiles"`);
  }
}
