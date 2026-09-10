import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuthStateCore } from '@wispace/account-link-core/core';
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

/** Discord edge adapter for encrypted, single-use OAuth state. */
@Injectable()
export class DiscordOauthStateService {
  private readonly logger = new Logger(DiscordOauthStateService.name);
  private readonly stateCore: OAuthStateCore<{ encryptedLinkToken: string }>;

  constructor(
    @Inject(DISCORD_OAUTH_STATE_REPOSITORY)
    private readonly repo: DiscordOauthStateRepositoryPort,
    @Optional()
    private readonly configService?: ConfigService,
  ) {
    this.stateCore = new OAuthStateCore(
      {
        save: async (state, payload, createdAt) =>
          this.repo.saveState({
            state,
            encryptedLinkToken: payload.encryptedLinkToken,
            createdAt,
          }),
        consume: async (state) => {
          const row = await this.repo.deleteByState(state);
          return row
            ? {
                payload: { encryptedLinkToken: row.linkToken },
                createdAt: row.createdAt,
              }
            : undefined;
        },
        cleanupExpired: (cutoff, limit) =>
          this.repo.deleteExpiredBefore(cutoff, limit),
      },
      {
        onCleanupError: (error) =>
          this.logger.warn(
            `Discord OAuth state cleanup failed: ${errorMessage(error)}`,
          ),
      },
    );
  }

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
    return this.stateCore.create({
      encryptedLinkToken: encryptAesGcm(linkToken, this.getEncryptionKey()),
    });
  }

  async consume(state: string): Promise<{ linkToken: string } | undefined> {
    const payload = await this.stateCore.consume(state);
    if (!payload) return undefined;

    try {
      return {
        linkToken: decryptAesGcm(
          payload.encryptedLinkToken,
          this.getEncryptionKey(),
          'discord_oauth_states link_token',
        ),
      };
    } catch (error) {
      this.logger.warn(
        `Discord OAuth state decryption failed: ${errorMessage(error)}`,
      );
      return undefined;
    }
  }
}
