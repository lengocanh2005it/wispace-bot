import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateLlmSafetyEventsTable1751029200000 implements MigrationInterface {
  name = 'CreateLlmSafetyEventsTable1751029200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "llm_safety_events" (
        "id"             BIGSERIAL PRIMARY KEY,
        "feature"        character varying(32)  NOT NULL,
        "event_type"     character varying(64)  NOT NULL,
        "reason"         character varying(100),
        "psid"           character varying(64),
        "user_id"        integer,
        "correlation_id" character varying(128),
        "payload"        jsonb,
        "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_llm_safety_created_at"
        ON "llm_safety_events" ("created_at")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_llm_safety_psid"
        ON "llm_safety_events" ("psid")
        WHERE "psid" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_llm_safety_psid"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_llm_safety_created_at"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "llm_safety_events"`);
  }
}
