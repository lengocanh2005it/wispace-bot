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
import { extractQueryRows } from '@wispace/bot-common/utils';
import { ZaloOauthStateEntity } from '@zalo/infrastructure/database/entities/zalo-oauth-state.entity';

const STATE_TTL_MS = 10 * 60 * 1000;

export interface ConsumedZaloOauthState {
  codeVerifier: string;
  linkToken: string;
}

/**
 * PKCE code_verifier staging between GET /zalo/oauth/authorize and
 * GET /zalo/oauth/callback (spec §5.2). TTL enforced in application code.
 * codeVerifier and linkToken are encrypted at rest with AES-256-GCM (#399).
 */
@Injectable()
export class ZaloOauthStateService {
  private readonly logger = new Logger(ZaloOauthStateService.name);

  constructor(
    @InjectRepository(ZaloOauthStateEntity)
    private readonly repo: Repository<ZaloOauthStateEntity>,
    @Optional()
    private readonly configService?: ConfigService,
  ) {}

  private getEncryptionKey(): Buffer {
    const raw =
      this.configService
        ?.get<string>('ZALO_OAUTH_STATE_ENCRYPTION_KEY')
        ?.trim() ||
      this.configService?.get<string>('OAUTH_STATE_ENCRYPTION_KEY')?.trim() ||
      this.configService?.get<string>('ZALO_TOKEN_ENCRYPTION_KEY')?.trim() ||
      process.env.ZALO_OAUTH_STATE_ENCRYPTION_KEY?.trim() ||
      process.env.OAUTH_STATE_ENCRYPTION_KEY?.trim() ||
      process.env.ZALO_TOKEN_ENCRYPTION_KEY?.trim();

    return parseEncryptionKey(raw, 'ZALO_OAUTH_STATE_ENCRYPTION_KEY');
  }

  async create(codeVerifier: string, linkToken: string): Promise<string> {
    const state = randomBytes(24).toString('hex');
    const key = this.getEncryptionKey();
    const encryptedVerifier = encryptAesGcm(codeVerifier, key);
    const encryptedLinkToken = encryptAesGcm(linkToken, key);

    await this.repo.save({
      state,
      codeVerifier: encryptedVerifier,
      linkToken: encryptedLinkToken,
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
      await this.repo.query(
        `DELETE FROM "zalo_oauth_states"
         WHERE "state" IN (
           SELECT "state" FROM "zalo_oauth_states"
           WHERE "created_at" < NOW() - ($1 * interval '1 millisecond')
           LIMIT 100
         )`,
        [STATE_TTL_MS],
      );
    } catch (error) {
      this.logger.warn(
        `Zalo OAuth state cleanup failed: ${errorMessage(error)}`,
      );
    }
  }

  /** Deletes the row regardless of outcome (single-use, even if expired). */
  async consume(state: string): Promise<ConsumedZaloOauthState | undefined> {
    const rows = extractQueryRows<{
      code_verifier: string;
      link_token: string;
      created_at: Date;
    }>(
      await this.repo.query(
        `DELETE FROM "zalo_oauth_states"
       WHERE "state" = $1
       RETURNING "code_verifier", "link_token", "created_at"`,
        [state],
      ),
    );
    const row = rows[0];
    if (!row) {
      return undefined;
    }

    const isExpired =
      Date.now() - new Date(row.created_at).getTime() > STATE_TTL_MS;
    if (isExpired) {
      return undefined;
    }

    try {
      const key = this.getEncryptionKey();
      const codeVerifier = decryptAesGcm(
        row.code_verifier,
        key,
        'zalo_oauth_states code_verifier',
      );
      const linkToken = decryptAesGcm(
        row.link_token,
        key,
        'zalo_oauth_states link_token',
      );
      return { codeVerifier, linkToken };
    } catch (err) {
      this.logger.warn(
        `Zalo OAuth state decryption failed: ${errorMessage(err)}`,
      );
      return undefined;
    }
  }
}
