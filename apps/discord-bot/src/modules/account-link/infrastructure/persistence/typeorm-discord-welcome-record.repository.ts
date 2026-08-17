import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DiscordWelcomeRecordEntity } from '@discord/infrastructure/database/entities/discord-welcome-record.entity';
import type {
  DiscordWelcomeRecordRepositoryPort,
  WelcomeSource,
} from '../../domain/ports/discord-welcome-record.repository.port';

/** TypeORM implementation of `DiscordWelcomeRecordRepositoryPort`. */
@Injectable()
export class TypeormDiscordWelcomeRecordRepository implements DiscordWelcomeRecordRepositoryPort {
  constructor(
    @InjectRepository(DiscordWelcomeRecordEntity)
    private readonly repo: Repository<DiscordWelcomeRecordEntity>,
  ) {}

  async tryClaimWelcome(
    discordUserId: string,
    windowMs: number,
    leaseMs: number,
  ): Promise<boolean> {
    // Single-statement conditional upsert (#159): the row is only updated
    // (claim taken) when the user was never welcomed, the last welcome is
    // older than the window, or a previous claim expired. RETURNING yields
    // exactly one row for the winner and none for a concurrent loser.
    const rows = await this.repo.manager.query<
      Array<{ discord_user_id: string }>
    >(
      `
        INSERT INTO discord_welcome_records (discord_user_id, claim_expires_at)
        VALUES ($1, now() + $2 * interval '1 millisecond')
        ON CONFLICT (discord_user_id)
        DO UPDATE SET claim_expires_at = EXCLUDED.claim_expires_at
        WHERE discord_welcome_records.last_welcomed_at IS NULL
           OR discord_welcome_records.last_welcomed_at <
              now() - $3 * interval '1 millisecond'
           OR discord_welcome_records.claim_expires_at < now()
        RETURNING discord_user_id
      `,
      [discordUserId, leaseMs, windowMs],
    );
    return rows.length > 0;
  }

  async markWelcomed(
    discordUserId: string,
    source: WelcomeSource,
  ): Promise<void> {
    await this.repo.upsert(
      {
        discordUserId,
        lastWelcomedAt: new Date(),
        source,
        claimExpiresAt: null,
      },
      ['discordUserId'],
    );
  }
}
