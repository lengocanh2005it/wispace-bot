import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { Repository } from 'typeorm';
import {
  decryptAesGcm,
  encryptAesGcm,
  parseEncryptionKey,
} from '@wispace/bot-common/utils';
import { errorMessage } from '@wispace/bot-common/masking';
import { DiscordOauthStateEntity } from '../../../../infrastructure/database/entities/discord-oauth-state.entity';

const STATE_TTL_MS = 10 * 60_000;

@Injectable()
export class DiscordOauthStateService {
  private readonly logger = new Logger(DiscordOauthStateService.name);

  constructor(
    @InjectRepository(DiscordOauthStateEntity)
    private readonly repo: Repository<DiscordOauthStateEntity>,
    @Optional()
    private readonly configService?: ConfigService,
  ) {}

  private getEncryptionKey(): Buffer {
    const raw =
      this.configService
        ?.get<string>('DISCORD_OAUTH_STATE_ENCRYPTION_KEY')
        ?.trim() ||
      this.configService?.get<string>('OAUTH_STATE_ENCRYPTION_KEY')?.trim() ||
      this.configService?.get<string>('DISCORD_TOKEN_ENCRYPTION_KEY')?.trim() ||
      process.env.DISCORD_OAUTH_STATE_ENCRYPTION_KEY?.trim() ||
      process.env.OAUTH_STATE_ENCRYPTION_KEY?.trim() ||
      process.env.DISCORD_TOKEN_ENCRYPTION_KEY?.trim();

    return parseEncryptionKey(raw, 'DISCORD_OAUTH_STATE_ENCRYPTION_KEY');
  }

  async create(linkToken: string): Promise<string> {
    const state = randomBytes(24).toString('hex');
    const encryptedLinkToken = encryptAesGcm(
      linkToken,
      this.getEncryptionKey(),
    );
    await this.repo.save(
      this.repo.create({
        state,
        linkToken: encryptedLinkToken,
        createdAt: new Date(),
      }),
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
    if (isExpired) return undefined;

    try {
      const linkToken = decryptAesGcm(
        row.link_token,
        this.getEncryptionKey(),
        'discord_oauth_states link_token',
      );
      return { linkToken };
    } catch (err) {
      this.logger.warn(
        `Discord OAuth state decryption failed for state=${state}: ${errorMessage(err)}`,
      );
      return undefined;
    }
  }
}
