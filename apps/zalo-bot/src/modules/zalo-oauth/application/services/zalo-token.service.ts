import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { errorMessage } from '@wispace/bot-common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { ZaloOaTokenEntity } from '@zalo/infrastructure/database/entities/zalo-oa-token.entity';

const ZALO_TOKEN_ENDPOINT = 'https://oauth.zaloapp.com/v4/access_token';
const EXPIRY_BUFFER_MS = 10 * 60 * 1000;
const REFRESH_MAX_ATTEMPTS = 3;
const REFRESH_BASE_BACKOFF_MS = 1_000;

interface ZaloAccessTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: string;
  refresh_token_expires_in: string;
}

class ZaloOaTokenRowMissingError extends InternalServerErrorException {
  constructor() {
    super('zalo_oa_tokens is empty — run the OA token bootstrap step first');
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
export class ZaloTokenService {
  private readonly logger = new Logger(ZaloTokenService.name);

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(ZaloOaTokenEntity)
    private readonly repo: Repository<ZaloOaTokenEntity>,
  ) {}

  async getValidAccessToken(): Promise<string> {
    const row = await this.repo.findOne({ where: {}, order: { id: 'DESC' } });
    if (!row) {
      throw new ZaloOaTokenRowMissingError();
    }

    if (this.isFresh(row)) {
      return row.accessToken;
    }

    return this.refresh();
  }

  /** Force a refresh regardless of current expiry — used by the cron (Task 5b). */
  async refreshNow(): Promise<void> {
    try {
      await this.refresh();
    } catch (error) {
      if (error instanceof ZaloOaTokenRowMissingError) {
        this.logger.warn('refreshNow skipped — zalo_oa_tokens is empty');
        return;
      }
      throw error;
    }
  }

  private isFresh(row: ZaloOaTokenEntity): boolean {
    return row.accessTokenExpiresAt.getTime() - EXPIRY_BUFFER_MS > Date.now();
  }

  private async refresh(): Promise<string> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= REFRESH_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.withTokenLock(
          async (em, row) => {
            if (this.isFresh(row)) {
              // Another worker refreshed while we waited for the lock — use its token.
              return row.accessToken;
            }
            return this.doRefresh(em, row);
          },
          () => {
            throw new ZaloOaTokenRowMissingError();
          },
        );
      } catch (error) {
        if (error instanceof ZaloOaTokenRowMissingError) {
          throw error;
        }

        lastError = error;
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

    throw new InternalServerErrorException(
      `Zalo OA token refresh failed after ${REFRESH_MAX_ATTEMPTS} attempts: ${errorMessage(
        lastError,
      )}`,
    );
  }

  /** Single-row transaction + FOR UPDATE; state is re-read after the lock. */
  private withTokenLock<T>(
    fn: (em: EntityManager, row: ZaloOaTokenEntity) => Promise<T>,
    onEmpty: () => T,
  ): Promise<T> {
    return this.repo.manager.transaction(async (em) => {
      const row = await em.findOne(ZaloOaTokenEntity, {
        where: {},
        order: { id: 'DESC' },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) {
        return onEmpty();
      }
      return fn(em, row);
    });
  }

  private async doRefresh(
    em: EntityManager,
    row: ZaloOaTokenEntity,
  ): Promise<string> {
    const appId = this.configService.getOrThrow<string>('ZALO_APP_ID');
    const secretKey = this.configService.getOrThrow<string>(
      'ZALO_APP_SECRET_KEY',
    );

    const response = await fetch(ZALO_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        secret_key: secretKey,
      },
      body: new URLSearchParams({
        refresh_token: row.refreshToken,
        app_id: appId,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Zalo OA token refresh failed: HTTP ${response.status}`);
    }

    const payload = (await response.json()) as ZaloAccessTokenResponse;

    const accessToken = payload.access_token;
    const refreshToken = payload.refresh_token;
    const expiresInSeconds = Number(payload.expires_in);
    const refreshExpiresInSeconds = Number(payload.refresh_token_expires_in);

    // Validate before persisting: a 200 response with an unexpected body
    // (e.g. an error payload without expires_in) must not write NaN dates
    // into the DB — fail this refresh attempt instead.
    if (
      typeof accessToken !== 'string' ||
      accessToken.trim() === '' ||
      typeof refreshToken !== 'string' ||
      refreshToken.trim() === '' ||
      !Number.isFinite(expiresInSeconds) ||
      expiresInSeconds <= 0 ||
      !Number.isFinite(refreshExpiresInSeconds) ||
      refreshExpiresInSeconds <= 0
    ) {
      throw new Error(
        'Zalo OA token refresh returned an invalid payload (missing access_token/refresh_token/expires_in)',
      );
    }

    const now = Date.now();

    await em.update(
      ZaloOaTokenEntity,
      { id: row.id, version: row.version },
      {
        accessToken,
        refreshToken,
        accessTokenExpiresAt: new Date(now + expiresInSeconds * 1000),
        refreshTokenExpiresAt: new Date(now + refreshExpiresInSeconds * 1000),
        updatedAt: new Date(now),
        version: row.version + 1,
      },
    );

    this.logger.log('Zalo OA access_token refreshed');
    return accessToken;
  }
}
