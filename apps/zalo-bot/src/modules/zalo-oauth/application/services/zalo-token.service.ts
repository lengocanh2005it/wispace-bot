import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ZaloOaTokenEntity } from '../../../../infrastructure/database/entities/zalo-oa-token.entity';

const ZALO_TOKEN_ENDPOINT = 'https://oauth.zaloapp.com/v4/access_token';
const EXPIRY_BUFFER_MS = 10 * 60 * 1000;

interface FetchLike {
  fetch: typeof fetch;
}

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
    private readonly http: FetchLike = { fetch },
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

    const response = await this.http.fetch(ZALO_TOKEN_ENDPOINT, {
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
    });

    if (!response.ok) {
      throw new InternalServerErrorException(
        `Zalo OA token refresh failed: HTTP ${response.status}`,
      );
    }

    const payload = (await response.json()) as ZaloAccessTokenResponse;
    const now = Date.now();

    await this.repo.update(row.id, {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      accessTokenExpiresAt: new Date(now + Number(payload.expires_in) * 1000),
      refreshTokenExpiresAt: new Date(
        now + Number(payload.refresh_token_expires_in) * 1000,
      ),
      updatedAt: new Date(now),
    });

    this.logger.log('Zalo OA access_token refreshed');
    return payload.access_token;
  }
}
