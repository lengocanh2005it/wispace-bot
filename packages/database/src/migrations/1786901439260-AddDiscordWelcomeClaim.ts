import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Atomic welcome-DM claim (#159): `claim_expires_at` on
 * `discord_welcome_records` is the in-flight lease taken by the conditional
 * upsert in `tryClaimWelcome`. A concurrent OAuth callback / `guildMemberAdd`
 * loses the claim (no duplicate DM), and a claim whose sender crashed or
 * failed becomes claimable again after the lease expires (retryable).
 * Only `apps/messenger-bot` runs migrations (Phase 5 convention).
 */
export class AddDiscordWelcomeClaim1786901439260 implements MigrationInterface {
  name = 'AddDiscordWelcomeClaim1786901439260';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "discord_welcome_records"
        ADD COLUMN IF NOT EXISTS "claim_expires_at" TIMESTAMPTZ NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "discord_welcome_records"
        DROP COLUMN IF EXISTS "claim_expires_at"
    `);
  }
}
