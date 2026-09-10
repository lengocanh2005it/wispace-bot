import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { errorMessage } from '@wispace/bot-common/masking';
import {
  ZALO_OAUTH_STATE_STORE,
  type ZaloOauthStateStorePort,
} from '../ports/zalo-oauth-state-store.port';

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
    @Inject(ZALO_OAUTH_STATE_STORE)
    private readonly store: ZaloOauthStateStorePort,
  ) {}

  async create(codeVerifier: string, linkToken: string): Promise<string> {
    const state = randomBytes(24).toString('hex');
    const createdAt = new Date();
    await this.store.save({
      state,
      codeVerifier,
      linkToken,
      createdAt,
    });
    await this.cleanupExpired(createdAt);
    return state;
  }

  // ponytail: opportunistic cleanup instead of a cron — bounded to 100 rows per
  // create; strictly older than STATE_TTL_MS so an in-flight valid callback is
  // never deleted.
  private async cleanupExpired(now: Date): Promise<void> {
    try {
      await this.store.cleanupExpired(
        new Date(now.getTime() - STATE_TTL_MS),
        100,
      );
    } catch (error) {
      this.logger.warn(
        `Zalo OAuth state cleanup failed: ${errorMessage(error)}`,
      );
    }
  }

  /** Deletes the row regardless of outcome (single-use, even if expired). */
  async consume(state: string): Promise<ConsumedZaloOauthState | undefined> {
    const row = await this.store.consume(state);
    if (!row) return undefined;

    const createdAt = row.createdAt.getTime();
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > STATE_TTL_MS) {
      return undefined;
    }

    return { codeVerifier: row.codeVerifier, linkToken: row.linkToken };
  }
}
