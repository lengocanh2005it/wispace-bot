import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import {
  decryptAesGcm,
  encryptAesGcm,
  extractQueryRows,
  parseEncryptionKey,
} from '@wispace/bot-common/utils';
import { errorMessage } from '@wispace/bot-common/masking';
import { ZaloOauthStateEntity } from '../../../../infrastructure/database/entities/zalo-oauth-state.entity';
import type {
  ZaloOauthStateRecord,
  ZaloOauthStateStorePort,
} from '../../application/ports/zalo-oauth-state-store.port';

/** TypeORM + AES-GCM adapter for single-use Zalo OAuth state (#429). */
@Injectable()
export class TypeormZaloOauthStateStoreAdapter implements ZaloOauthStateStorePort {
  private readonly logger = new Logger(TypeormZaloOauthStateStoreAdapter.name);

  constructor(
    @InjectRepository(ZaloOauthStateEntity)
    private readonly repo: Repository<ZaloOauthStateEntity>,
    @Optional() private readonly configService?: ConfigService,
  ) {}

  async save(record: ZaloOauthStateRecord): Promise<void> {
    const key = this.getEncryptionKey();
    await this.repo.save({
      state: record.state,
      codeVerifier: encryptAesGcm(record.codeVerifier, key),
      linkToken: encryptAesGcm(record.linkToken, key),
      createdAt: record.createdAt,
    });
  }

  async consume(state: string): Promise<ZaloOauthStateRecord | undefined> {
    const rows = extractQueryRows<{
      state: string;
      code_verifier: string;
      link_token: string;
      created_at: Date | string;
    }>(
      await this.repo.query(
        `DELETE FROM "zalo_oauth_states"
       WHERE "state" = $1
       RETURNING "state", "code_verifier", "link_token", "created_at"`,
        [state],
      ),
    );
    const row = rows[0];
    if (!row) return undefined;

    try {
      const key = this.getEncryptionKey();
      return {
        state: row.state,
        codeVerifier: decryptAesGcm(
          row.code_verifier,
          key,
          'zalo_oauth_states code_verifier',
        ),
        linkToken: decryptAesGcm(
          row.link_token,
          key,
          'zalo_oauth_states link_token',
        ),
        createdAt: new Date(row.created_at),
      };
    } catch (error) {
      this.logger.warn(
        `Zalo OAuth state decryption failed: ${errorMessage(error)}`,
      );
      return undefined;
    }
  }

  async cleanupExpired(before: Date, limit: number): Promise<void> {
    await this.repo.query(
      `DELETE FROM "zalo_oauth_states"
       WHERE "state" IN (
         SELECT "state" FROM "zalo_oauth_states"
         WHERE "created_at" < $1
         ORDER BY "created_at" ASC
         LIMIT $2
       )`,
      [before, limit],
    );
  }

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
}
