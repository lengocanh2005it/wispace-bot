import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

/**
 * Owns the single-row `zalo_oa_tokens` OA server-to-server token pair.
 * access_token: 1h, refresh_token: 30 days, single-use (must persist the new
 * pair returned by every refresh call) — see spec §5.1. Bootstrap (first
 * token pair) is a manual one-time ops step, not handled here.
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
      throw new InternalServerErrorException(
        'zalo_oa_tokens is empty — run the OA token bootstrap step first',
      );
    }

    const expiresAt = row.accessTokenExpiresAt.getTime();
    if (expiresAt - EXPIRY_BUFFER_MS > Date.now()) {
      return row.accessToken;
    }

    return this.refresh(row);
  }

  /** Force a refresh regardless of current expiry — used by the cron (Task 5b). */
  async refreshNow(): Promise<void> {
    const row = await this.repo.findOne({ where: {}, order: { id: 'DESC' } });
    if (!row) {
      this.logger.warn('refreshNow skipped — zalo_oa_tokens is empty');
      return;
    }
    await this.refresh(row);
  }

  private async refresh(row: ZaloOaTokenEntity): Promise<string> {
    const appId = this.configService.getOrThrow<string>('ZALO_APP_ID');
    const secretKey = this.configService.getOrThrow<string>(
      'ZALO_APP_SECRET_KEY',
    );

    let lastError: unknown;

    for (let attempt = 1; attempt <= REFRESH_MAX_ATTEMPTS; attempt++) {
      try {
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
          throw new Error(
            `Zalo OA token refresh failed: HTTP ${response.status}`,
          );
        }

        const payload = (await response.json()) as ZaloAccessTokenResponse;
        const now = Date.now();

        await this.repo.update(row.id, {
          accessToken: payload.access_token,
          refreshToken: payload.refresh_token,
          accessTokenExpiresAt: new Date(
            now + Number(payload.expires_in) * 1000,
          ),
          refreshTokenExpiresAt: new Date(
            now + Number(payload.refresh_token_expires_in) * 1000,
          ),
          updatedAt: new Date(now),
        });

        this.logger.log('Zalo OA access_token refreshed');
        return payload.access_token;
      } catch (error) {
        lastError = error;
        if (attempt < REFRESH_MAX_ATTEMPTS) {
          const backoffMs = REFRESH_BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
          this.logger.warn(
            `Zalo OA token refresh attempt ${attempt}/${REFRESH_MAX_ATTEMPTS} failed, retrying in ${backoffMs}ms: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          await new Promise((r) => setTimeout(r, backoffMs));
        }
      }
    }

    throw new InternalServerErrorException(
      `Zalo OA token refresh failed after ${REFRESH_MAX_ATTEMPTS} attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }
}
