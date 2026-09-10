import {
  Injectable,
  InternalServerErrorException,
  Logger,
  Inject,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { errorMessage } from '@wispace/bot-common/masking';
import { PlatformConnectivityState } from '@wispace/bot-common/health';
import {
  BotMetricsService,
  type TokenRefreshFailureReason,
} from '@wispace/bot-metrics';
import {
  ZALO_OAUTH_CLIENT,
  type ZaloOAuthClientPort,
} from '../ports/zalo-oauth-client.port';
import {
  ZALO_OA_TOKEN_STORE,
  type ZaloOaTokenSnapshot,
  type ZaloOaTokenStorePort,
} from '../ports/zalo-oa-token-store.port';
const EXPIRY_BUFFER_MS = 10 * 60 * 1000;
const REFRESH_MAX_ATTEMPTS = 3;
const REFRESH_BASE_BACKOFF_MS = 1_000;

class ZaloOaTokenRowMissingError extends InternalServerErrorException {
  constructor() {
    super('zalo_oa_tokens is empty — run the OA token bootstrap step first');
  }
}

class ZaloTokenRefreshError extends InternalServerErrorException {
  constructor(
    message: string,
    readonly failureReason: Exclude<TokenRefreshFailureReason, 'missing'>,
  ) {
    super(message);
  }
}

/**
 * Owns the single-row `zalo_oa_tokens` OA server-to-server token pair.
 * access_token: 1h, refresh_token: 30 days, single-use (must persist the new
 * pair returned by every refresh call) — see spec §5.1. Bootstrap (first
 * token pair) is a manual one-time ops step, not handled here.
 *
 * Refresh is serialized across workers/replicas: the expired path takes a
 * pessimistic row lock (SELECT ... FOR UPDATE) in a transaction, re-reads
 * expiry AFTER acquiring the lock (another worker may have already
 * refreshed), and only then submits the current persisted refresh token.
 * Retries re-acquire the lock and re-read the row — never a stale snapshot.
 */
@Injectable()
export class ZaloTokenService implements OnModuleInit {
  private readonly logger = new Logger(ZaloTokenService.name);
  private cachedToken: { accessToken: string; expiresAt: number } | null = null;
  private lastKnownAccessTokenExpiresAt = 0;

  constructor(
    @Inject(ZALO_OA_TOKEN_STORE)
    private readonly tokenStore: ZaloOaTokenStorePort,
    @Inject(ZALO_OAUTH_CLIENT)
    private readonly oauthClient: ZaloOAuthClientPort,
    @Optional()
    @Inject(PlatformConnectivityState)
    private readonly platformState?: PlatformConnectivityState,
    @Optional()
    private readonly metrics?: BotMetricsService,
  ) {}

  onModuleInit(): void {
    void this.refreshHealthState();
  }

  async getValidAccessToken(): Promise<string> {
    // ponytail: in-process cache — token valid ~1h, single-row table, ~99% hit rate
    if (
      this.cachedToken &&
      this.cachedToken.expiresAt - EXPIRY_BUFFER_MS > Date.now()
    ) {
      return this.cachedToken.accessToken;
    }

    const row = await this.tokenStore.readCurrent();
    if (!row) {
      this.markTokenMissing();
      throw new ZaloOaTokenRowMissingError();
    }

    if (this.isFresh(row)) {
      this.cachedToken = {
        accessToken: row.accessToken,
        expiresAt: row.accessTokenExpiresAt.getTime(),
      };
      this.lastKnownAccessTokenExpiresAt = row.accessTokenExpiresAt.getTime();
      this.markConnected();
      return row.accessToken;
    }

    try {
      return await this.refresh();
    } catch (error) {
      if (error instanceof ZaloOaTokenRowMissingError) {
        this.markTokenMissing();
      } else {
        this.markRefreshFailure(error);
      }
      throw error;
    }
  }

  /** Force a refresh regardless of current expiry — used by the cron (Task 5b). */
  async refreshNow(): Promise<void> {
    try {
      await this.refresh();
    } catch (error) {
      if (error instanceof ZaloOaTokenRowMissingError) {
        this.logger.warn('refreshNow skipped — zalo_oa_tokens is empty');
        this.markTokenMissing();
        return;
      }
      this.markRefreshFailure(error);
      throw error;
    }
  }

  private isFresh(row: ZaloOaTokenSnapshot): boolean {
    return row.accessTokenExpiresAt.getTime() - EXPIRY_BUFFER_MS > Date.now();
  }

  private async refresh(): Promise<string> {
    let lastError: unknown;
    let previousAttemptTimedOut = false;
    let failureReason: Exclude<TokenRefreshFailureReason, 'missing'> =
      'network';
    let submittedRefresh = false;

    for (let attempt = 1; attempt <= REFRESH_MAX_ATTEMPTS; attempt++) {
      submittedRefresh = false;
      try {
        const row = await this.tokenStore.refreshWithLock(async (current) => {
          if (this.isFresh(current)) {
            // Another worker refreshed while we waited for the lock — keep its token.
            return undefined;
          }
          submittedRefresh = true;
          return this.oauthClient.refreshOaToken(current.refreshToken);
        });
        if (!row) throw new ZaloOaTokenRowMissingError();
        this.cacheToken(row);
        if (submittedRefresh) {
          this.logger.log('Zalo OA access_token refreshed');
        }
        this.markConnected();
        return row.accessToken;
      } catch (error) {
        if (error instanceof ZaloOaTokenRowMissingError) {
          throw error;
        }

        // If a previous attempt timed out (server may have consumed the
        // single-use token) and this attempt gets a non-timeout error,
        // the token is likely already consumed — stop retrying (#154).
        if (previousAttemptTimedOut && !this.isTimeoutError(error)) {
          this.logger.warn(
            `Zalo OA token refresh: previous timeout likely consumed token, non-timeout error on retry: ${errorMessage(error)}`,
          );
          lastError = error;
          failureReason = 'consumed';
          break;
        }

        if (this.isTimeoutError(error)) {
          previousAttemptTimedOut = true;
        }

        lastError = error;
        failureReason = this.classifyRefreshFailure(error);
        if (attempt < REFRESH_MAX_ATTEMPTS) {
          const backoffMs = REFRESH_BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
          this.logger.warn(
            `Zalo OA token refresh attempt ${attempt}/${REFRESH_MAX_ATTEMPTS} failed, retrying in ${backoffMs}ms: ${errorMessage(
              error,
            )}`,
          );
          await new Promise((r) => setTimeout(r, backoffMs));
        }
      }
    }

    const refreshError = new ZaloTokenRefreshError(
      `Zalo OA token refresh failed after ${REFRESH_MAX_ATTEMPTS} attempts: ${errorMessage(
        lastError,
      )}`,
      previousAttemptTimedOut && failureReason !== 'timeout'
        ? 'consumed'
        : failureReason,
    );
    throw refreshError;
  }

  private async refreshHealthState(): Promise<void> {
    try {
      const row = await this.tokenStore.readCurrent();
      if (!row) {
        this.markTokenMissing();
        return;
      }
      if (this.isFresh(row)) {
        this.cacheToken(row);
        this.markConnected();
        return;
      }
      await this.refresh();
    } catch (error) {
      if (error instanceof ZaloOaTokenRowMissingError) {
        this.markTokenMissing();
      } else {
        this.markRefreshFailure(error);
      }
    }
  }

  private markConnected(): void {
    const now = new Date().toISOString();
    this.platformState?.transition({
      status: 'connected',
      ready: true,
      reason: 'connected',
      lastConnectedAt: now,
      lastVerifiedAt: now,
    });
  }

  private markTokenMissing(): void {
    this.markUnavailable('token_missing');
    this.metrics?.incTokenRefreshFailure('missing');
  }

  private markUnavailable(
    reason: 'token_missing' | 'token_refresh_failed' | 'token_refresh_rejected',
  ): void {
    const current = this.platformState?.getSnapshot();
    const cachedTokenUsable =
      this.lastKnownAccessTokenExpiresAt - EXPIRY_BUFFER_MS > Date.now();
    const status =
      cachedTokenUsable && reason === 'token_refresh_failed'
        ? 'reconnecting'
        : 'unavailable';
    this.platformState?.transition({
      status,
      ready: cachedTokenUsable,
      reason: cachedTokenUsable ? 'reconnect_grace' : reason,
      lastConnectedAt: current?.lastConnectedAt ?? null,
      lastVerifiedAt: current?.lastVerifiedAt ?? null,
    });
  }

  private markRefreshFailure(error: unknown): void {
    const reason =
      error instanceof ZaloTokenRefreshError
        ? error.failureReason
        : this.classifyRefreshFailure(error);
    if (reason === 'rejected') {
      this.markUnavailable('token_refresh_rejected');
    } else {
      this.markUnavailable('token_refresh_failed');
    }
    this.metrics?.incTokenRefreshFailure(reason);
  }

  private classifyRefreshFailure(
    error: unknown,
  ): Exclude<TokenRefreshFailureReason, 'missing' | 'consumed'> {
    if (this.isTimeoutError(error)) return 'timeout';
    const message = errorMessage(error);
    if (/HTTP (400|401|403)\b/.test(message)) return 'rejected';
    if (/invalid payload/i.test(message)) return 'invalid_response';
    return 'network';
  }

  private isTimeoutError(error: unknown): boolean {
    return (
      error instanceof Error &&
      (error.name === 'AbortError' || error.message.includes('abort'))
    );
  }

  private cacheToken(row: ZaloOaTokenSnapshot): void {
    const expiresAt = row.accessTokenExpiresAt.getTime();
    this.cachedToken = { accessToken: row.accessToken, expiresAt };
    this.lastKnownAccessTokenExpiresAt = expiresAt;
  }
}
