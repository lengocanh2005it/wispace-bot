import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readBoundedJson } from '@wispace/bot-common/utils';
import type {
  ZaloOAuthClientPort,
  ZaloUserProfile,
} from '../../application/ports/zalo-oauth-client.port';
import type { ZaloOaTokenPair } from '../../application/ports/zalo-oa-token-store.port';

const ZALO_TOKEN_ENDPOINT = 'https://oauth.zaloapp.com/v4/access_token';
const ZALO_ME_ENDPOINT = 'https://graph.zalo.me/v2.0/me';
const OAUTH_TIMEOUT_MS = 10_000;

interface ZaloAccessTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: string | number;
  refresh_token_expires_in?: string | number;
}

class ZaloOAuthHttpError extends Error {}

function mergeWithTimeout(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(OAUTH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function requirePositiveSeconds(value: string | number | undefined): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new ZaloOAuthHttpError(
      'Zalo OA token refresh returned an invalid payload (missing access_token/refresh_token/expires_in)',
    );
  }
  return seconds;
}

/** Zalo Login/OA OAuth HTTP adapter (#429). */
@Injectable()
export class ZaloOAuthHttpAdapter implements ZaloOAuthClientPort {
  constructor(private readonly configService: ConfigService) {}

  async exchangeCodeForUser(
    code: string,
    codeVerifier: string,
    signal?: AbortSignal,
  ): Promise<ZaloUserProfile> {
    const tokenResponse = await fetch(ZALO_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        secret_key: this.configService.getOrThrow<string>(
          'ZALO_APP_SECRET_KEY',
        ),
      },
      body: new URLSearchParams({
        code,
        app_id: this.configService.getOrThrow<string>('ZALO_APP_ID'),
        grant_type: 'authorization_code',
        code_verifier: codeVerifier,
      }),
      signal: mergeWithTimeout(signal),
    });

    if (!tokenResponse.ok) {
      throw new ZaloOAuthHttpError(
        `Zalo token exchange failed: ${tokenResponse.status}`,
      );
    }

    const tokenJson = await readBoundedJson<{ access_token?: string }>(
      tokenResponse,
    );
    if (
      typeof tokenJson.access_token !== 'string' ||
      tokenJson.access_token.trim() === ''
    ) {
      throw new ZaloOAuthHttpError(
        'Zalo token exchange returned an invalid access token',
      );
    }

    const userResponse = await fetch(`${ZALO_ME_ENDPOINT}?fields=id,name`, {
      headers: { access_token: tokenJson.access_token },
      signal: mergeWithTimeout(signal),
    });

    if (!userResponse.ok) {
      throw new ZaloOAuthHttpError(
        `Zalo user fetch failed: ${userResponse.status}`,
      );
    }

    const userJson = await readBoundedJson<{ id?: string; name?: string }>(
      userResponse,
    );
    if (
      typeof userJson.id !== 'string' ||
      userJson.id.trim() === '' ||
      typeof userJson.name !== 'string'
    ) {
      throw new ZaloOAuthHttpError(
        'Zalo user fetch returned an invalid profile',
      );
    }

    return { id: userJson.id, name: userJson.name };
  }

  async refreshOaToken(
    refreshToken: string,
    signal?: AbortSignal,
  ): Promise<ZaloOaTokenPair> {
    const response = await fetch(ZALO_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        secret_key: this.configService.getOrThrow<string>(
          'ZALO_APP_SECRET_KEY',
        ),
      },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        app_id: this.configService.getOrThrow<string>('ZALO_APP_ID'),
        grant_type: 'refresh_token',
      }),
      signal: mergeWithTimeout(signal),
    });

    if (!response.ok) {
      throw new Error(`Zalo OA token refresh failed: HTTP ${response.status}`);
    }

    const payload = await readBoundedJson<ZaloAccessTokenResponse>(response);
    const accessToken = payload.access_token;
    const nextRefreshToken = payload.refresh_token;
    const expiresInSeconds = requirePositiveSeconds(payload.expires_in);
    const refreshExpiresInSeconds = requirePositiveSeconds(
      payload.refresh_token_expires_in,
    );

    if (
      typeof accessToken !== 'string' ||
      accessToken.trim() === '' ||
      typeof nextRefreshToken !== 'string' ||
      nextRefreshToken.trim() === ''
    ) {
      throw new Error(
        'Zalo OA token refresh returned an invalid payload (missing access_token/refresh_token/expires_in)',
      );
    }

    const now = Date.now();
    return {
      accessToken,
      refreshToken: nextRefreshToken,
      accessTokenExpiresAt: new Date(now + expiresInSeconds * 1000),
      refreshTokenExpiresAt: new Date(now + refreshExpiresInSeconds * 1000),
    };
  }
}
