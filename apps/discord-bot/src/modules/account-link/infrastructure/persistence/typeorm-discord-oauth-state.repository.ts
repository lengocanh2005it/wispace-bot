import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { extractQueryRows } from '@wispace/bot-common/utils';
import { DiscordOauthStateEntity } from '@discord/infrastructure/database/entities/discord-oauth-state.entity';
import type { DiscordOauthStateRepositoryPort } from '../../domain/ports/discord-oauth-state.repository.port';

/** TypeORM persistence for single-use OAuth link states (#428). */
@Injectable()
export class TypeormDiscordOauthStateRepository implements DiscordOauthStateRepositoryPort {
  constructor(
    @InjectRepository(DiscordOauthStateEntity)
    private readonly repo: Repository<DiscordOauthStateEntity>,
  ) {}

  async saveState(input: {
    state: string;
    encryptedLinkToken: string;
    createdAt: Date;
  }): Promise<void> {
    await this.repo.save(
      this.repo.create({
        state: input.state,
        linkToken: input.encryptedLinkToken,
        createdAt: input.createdAt,
      }),
    );
  }

  async deleteByState(
    state: string,
  ): Promise<{ linkToken: string; createdAt: Date } | undefined> {
    const rows = extractQueryRows<{ link_token: string; created_at: Date }>(
      await this.repo.query(
        `DELETE FROM "discord_oauth_states"
       WHERE "state" = $1
       RETURNING "link_token", "created_at"`,
        [state],
      ),
    );
    const row = rows[0];
    if (!row) return undefined;
    return { linkToken: row.link_token, createdAt: new Date(row.created_at) };
  }

  async deleteExpiredBefore(cutoff: Date, limit: number): Promise<void> {
    await this.repo.query(
      `DELETE FROM "discord_oauth_states"
       WHERE "state" IN (
         SELECT "state" FROM "discord_oauth_states"
         WHERE "created_at" < $1
         LIMIT $2
       )`,
      [cutoff, limit],
    );
  }
}
