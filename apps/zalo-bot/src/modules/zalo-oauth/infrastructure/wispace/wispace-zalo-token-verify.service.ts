import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  ZaloLinkVerifyResult,
  ZaloTokenVerifyPort,
} from '../../domain/ports/zalo-token-verify.port';

const VERIFY_FAILURE_REASONS = [
  'NOT_FOUND',
  'EXPIRED',
  'USED',
  'INVALID_FORMAT',
] as const;
const VERIFY_TIMEOUT_MS = 10_000;

/**
 * Calls WISPACE's shared account-link verify API — same
 * WISPACE_API_VERIFY_TOKEN_URL endpoint used by all 3 bots, payload
 * { token, value, platform: 'zalo' } — mirrors
 * apps/discord-bot's WispaceDiscordTokenVerifyService.
 */
@Injectable()
export class WispaceZaloTokenVerifyService implements ZaloTokenVerifyPort {
  private readonly logger = new Logger(WispaceZaloTokenVerifyService.name);

  constructor(private readonly configService: ConfigService) {}

  async verifyToken(
    token: string,
    zaloUserId: string,
  ): Promise<ZaloLinkVerifyResult> {
    const url = this.getVerifyUrl();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': this.getInternalKey(),
      },
      body: JSON.stringify({
        token: token.trim(),
        value: zaloUserId.trim(),
        platform: 'zalo',
      }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });

    const text = await response.text();
    const payload: unknown = text.trim() ? JSON.parse(text) : undefined;

    if (response.ok) {
      return this.parseSuccessPayload(payload);
    }

    const failure = this.parseFailurePayload(payload);
    if (failure) {
      return failure;
    }

    throw new InternalServerErrorException(
      `WISPACE verify-zalo-token failed: HTTP ${response.status}`,
    );
  }

  private getVerifyUrl(): string {
    const url = this.configService
      .get<string>('WISPACE_API_VERIFY_TOKEN_URL')
      ?.trim();
    if (!url) {
      throw new InternalServerErrorException(
        'WISPACE_API_VERIFY_TOKEN_URL must be set in .env',
      );
    }
    return url;
  }

  private getInternalKey(): string {
    const key = this.configService.get<string>('WISPACE_INTERNAL_KEY')?.trim();
    if (!key) {
      throw new InternalServerErrorException(
        'WISPACE_INTERNAL_KEY must be set in .env',
      );
    }
    return key;
  }

  private parseSuccessPayload(payload: unknown): ZaloLinkVerifyResult {
    if (!payload || typeof payload !== 'object') {
      throw new InternalServerErrorException(
        'WISPACE verify-zalo-token returned invalid JSON body',
      );
    }
    const record = payload as Record<string, unknown>;
    const userId = Number(record.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      throw new InternalServerErrorException(
        'WISPACE verify-zalo-token missing userId in success response',
      );
    }
    this.logger.log(`WISPACE verify-zalo-token OK userId=${userId}`);
    return { valid: true, userId };
  }

  private parseFailurePayload(
    payload: unknown,
  ): ZaloLinkVerifyResult | undefined {
    if (!payload || typeof payload !== 'object') {
      return undefined;
    }
    const record = payload as Record<string, unknown>;
    const reason = record.reason ?? record.error;
    if (typeof reason !== 'string') {
      return undefined;
    }
    const normalized = reason.trim().toUpperCase();
    const matched = VERIFY_FAILURE_REASONS.find((r) => r === normalized);
    return matched ? { valid: false, reason: matched } : undefined;
  }
}
