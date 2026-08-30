import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import {
  decryptAesGcm,
  encryptAesGcm,
  parseEncryptionKey,
} from '@wispace/bot-common/utils';
import { errorMessage } from '@wispace/bot-common/masking';
import {
  DISCORD_OAUTH_STATE_REPOSITORY,
  type DiscordOauthStateRepositoryPort,
} from '../../domain/ports/discord-oauth-state.repository.port';

const STATE_TTL_MS = 10 * 60_000;

/**
 * Single-use OAuth link-state use case — owns state generation, TTL
 * judgment, and AES-GCM decryption. Persistence flows through
 * `DiscordOauthStateRepositoryPort` (bound to the TypeORM implementation in
 * module wiring, #428).
 */
@Injectable()
export class DiscordOauthStateService {
  private readonly logger = new Logger(DiscordOauthStateService.name);

  constructor(
    @Inject(DISCORD_OAUTH_STATE_REPOSITORY)
    private readonly repo: DiscordOauthStateRepositoryPort,
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
    await this.repo.saveState({
      state,
      encryptedLinkToken,
      createdAt: new Date(),
    });
    await this.cleanupExpired();
    return state;
  }

  // ponytail: opportunistic cleanup instead of a cron — bounded to 100 rows per
  // create; strictly older than STATE_TTL_MS so an in-flight valid callback is
  // never deleted.
  private async cleanupExpired(): Promise<void> {
    try {
      await this.repo.deleteExpiredBefore(
        new Date(Date.now() - STATE_TTL_MS),
        100,
      );
    } catch (error) {
      this.logger.warn(
        `Discord OAuth state cleanup failed: ${errorMessage(error)}`,
      );
    }
  }

  async consume(state: string): Promise<{ linkToken: string } | undefined> {
    const row = await this.repo.deleteByState(state);
    if (!row) return undefined;

    const isExpired = Date.now() - row.createdAt.getTime() > STATE_TTL_MS;
    if (isExpired) return undefined;

    try {
      const linkToken = decryptAesGcm(
        row.linkToken,
        this.getEncryptionKey(),
        'discord_oauth_states link_token',
      );
      return { linkToken };
    } catch (err) {
      this.logger.warn(
        `Discord OAuth state decryption failed: ${errorMessage(err)}`,
      );
      return undefined;
    }
  }
}
