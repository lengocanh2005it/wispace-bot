import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { Repository } from 'typeorm';
import { DiscordOauthStateEntity } from '../../../../infrastructure/database/entities/discord-oauth-state.entity';

const STATE_TTL_MS = 10 * 60_000;

@Injectable()
export class DiscordOauthStateService {
  constructor(
    @InjectRepository(DiscordOauthStateEntity)
    private readonly repo: Repository<DiscordOauthStateEntity>,
  ) {}

  async create(linkToken: string): Promise<string> {
    const state = randomBytes(24).toString('hex');
    await this.repo.save(
      this.repo.create({ state, linkToken, createdAt: new Date() }),
    );
    return state;
  }

  async consume(state: string): Promise<{ linkToken: string } | undefined> {
    const rows = await this.repo.query<
      Array<{ link_token: string; created_at: Date }>
    >(
      `DELETE FROM "discord_oauth_states"
       WHERE "state" = $1
       RETURNING "link_token", "created_at"`,
      [state],
    );
    const row = rows[0];
    if (!row) return undefined;

    const isExpired =
      Date.now() - new Date(row.created_at).getTime() > STATE_TTL_MS;
    return isExpired ? undefined : { linkToken: row.link_token };
  }
}
