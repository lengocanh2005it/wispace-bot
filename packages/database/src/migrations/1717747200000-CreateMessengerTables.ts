import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMessengerTables1717747200000 implements MigrationInterface {
  name = 'CreateMessengerTables1717747200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "user_messenger_mappings" (
        "id" SERIAL NOT NULL,
        "user_id" integer,
        "psid" character varying(64),
        "notification_messages_token" text NOT NULL,
        "cadence" character varying(10),
        "topic" character varying(100),
        "status" character varying(10) NOT NULL DEFAULT 'ACTIVE',
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_messenger_mappings" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_messenger_mappings_token"
      ON "user_messenger_mappings" ("notification_messages_token")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_user_messenger_mappings_cadence_status"
      ON "user_messenger_mappings" ("cadence", "status")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "messenger_message_logs" (
        "id" SERIAL NOT NULL,
        "user_id" integer,
        "psid" character varying(64),
        "message_type" character varying(50) NOT NULL,
        "message_text" text NOT NULL,
        "status" character varying(20) NOT NULL,
        "error_message" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_messenger_message_logs" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'user_profiles'
        ) AND NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_name = 'fk_user_messenger_mappings_user_id'
        ) THEN
          ALTER TABLE "user_messenger_mappings"
            ADD CONSTRAINT "fk_user_messenger_mappings_user_id"
            FOREIGN KEY ("user_id") REFERENCES "user_profiles"("user_id");
        END IF;
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE IF EXISTS "user_messenger_mappings"
      DROP CONSTRAINT IF EXISTS "fk_user_messenger_mappings_user_id"
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "messenger_message_logs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_messenger_mappings"`);
  }
}
