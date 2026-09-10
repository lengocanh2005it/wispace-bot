import { Inject, Injectable, Logger } from '@nestjs/common';
import { OAuthStateCore } from '@wispace/account-link-core/core';
import { errorMessage } from '@wispace/bot-common/masking';
import {
  ZALO_OAUTH_STATE_STORE,
  type ZaloOauthStateStorePort,
} from '../ports/zalo-oauth-state-store.port';

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
  private readonly stateCore: OAuthStateCore<{
    codeVerifier: string;
    linkToken: string;
  }>;

  constructor(
    @Inject(ZALO_OAUTH_STATE_STORE)
    private readonly store: ZaloOauthStateStorePort,
  ) {
    this.stateCore = new OAuthStateCore(
      {
        save: (state, payload, createdAt) =>
          this.store.save({ state, ...payload, createdAt }),
        consume: async (state) => {
          const row = await this.store.consume(state);
          return row
            ? {
                payload: {
                  codeVerifier: row.codeVerifier,
                  linkToken: row.linkToken,
                },
                createdAt: row.createdAt,
              }
            : undefined;
        },
        cleanupExpired: (before, limit) =>
          this.store.cleanupExpired(before, limit),
      },
      {
        onCleanupError: (error) =>
          this.logger.warn(
            `Zalo OAuth state cleanup failed: ${errorMessage(error)}`,
          ),
      },
    );
  }

  async create(codeVerifier: string, linkToken: string): Promise<string> {
    return this.stateCore.create({ codeVerifier, linkToken });
  }

  /** Deletes the row regardless of outcome (single-use, even if expired). */
  async consume(state: string): Promise<ConsumedZaloOauthState | undefined> {
    return this.stateCore.consume(state);
  }
}
