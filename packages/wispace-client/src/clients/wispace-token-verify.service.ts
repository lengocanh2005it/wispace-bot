import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { maskExternalId } from '@wispace/bot-common/masking';
import { readResponseText } from '@wispace/bot-common/utils';
import { mergeWithTimeout } from '../utils/abort-signal.utils';
import { keepAliveFetch } from '../utils/keep-alive-agent';
import {
  validateUpstreamUrl,
  buildUpstreamUrlPolicy,
} from '../utils/upstream-url.utils';
import type {
  WispaceLinkVerifyFailureReason,
  WispaceLinkVerifyResult,
} from '../types/token-verify.types';

const VERIFY_FAILURE_REASONS: WispaceLinkVerifyFailureReason[] = [
  'NOT_FOUND',
  'EXPIRED',
  'USED',
  'INVALID_FORMAT',
];

/**
 * Calls WISPACE's shared account-link verify API — the same
 * `WISPACE_API_VERIFY_TOKEN_URL` endpoint used by all 3 bots, payload
 * `{ token, value, platform }`. WISPACE owns the token and its expiry/usage
 * state; we just verify + resolve `userId` server-to-server. The platform
 * string is injected per app (e.g. 'discord', 'zalo') — mirrors how
 * `WispaceGoalsService` takes its per-app id-header.
 */
@Injectable()
export class WispaceTokenVerifyService {
  private readonly logger = new Logger(WispaceTokenVerifyService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly platform: string,
  ) {}

  async verifyToken(
    token: string,
    value: string,
    options?: { signal?: AbortSignal },
  ): Promise<WispaceLinkVerifyResult> {
    const url = this.getVerifyUrl();
    const fetchSignal = mergeWithTimeout(options?.signal, 10_000);

    const response = await keepAliveFetch(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Key': this.getInternalKey(),
        },
        body: JSON.stringify({
          token: token.trim(),
          value: value.trim(),
          platform: this.platform,
        }),
        signal: fetchSignal,
      },
      { logger: this.logger },
    );

    const payload: unknown = await this.readJsonBody(response);

    if (response.ok) {
      return this.parseSuccessPayload(payload);
    }

    const failure = this.parseFailurePayload(payload);
    if (failure) {
      return failure;
    }

    throw new InternalServerErrorException(
      `WISPACE verify-${this.platform}-token failed: HTTP ${response.status} ${response.statusText}`,
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

    return validateUpstreamUrl(
      url,
      buildUpstreamUrlPolicy('WISPACE_API_VERIFY_TOKEN_URL', {
        get: (key) => this.configService.get<string>(key),
      }),
    );
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

  private async readJsonBody(response: Response): Promise<unknown> {
    const text = await readResponseText(response);
    if (!text.trim()) {
      return undefined;
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { raw: text };
    }
  }

  private parseSuccessPayload(payload: unknown): WispaceLinkVerifyResult {
    if (!payload || typeof payload !== 'object') {
      throw new InternalServerErrorException(
        `WISPACE verify-${this.platform}-token returned invalid JSON body`,
      );
    }

    const record = payload as Record<string, unknown>;

    if (record.success === false || record.valid === false) {
      const failure = this.parseFailurePayload(payload);
      if (failure) {
        return failure;
      }
      return { valid: false, reason: 'NOT_FOUND' };
    }

    const userId = this.readPositiveInt(record.userId);
    if (!userId) {
      throw new InternalServerErrorException(
        `WISPACE verify-${this.platform}-token missing userId in success response`,
      );
    }

    this.logger.log(
      `WISPACE verify-${this.platform}-token OK userId=${maskExternalId(userId)}`,
    );

    return { valid: true, userId };
  }

  private parseFailurePayload(
    payload: unknown,
  ): WispaceLinkVerifyResult | undefined {
    if (!payload || typeof payload !== 'object') {
      return undefined;
    }

    const record = payload as Record<string, unknown>;
    const reason = this.readFailureReason(record.reason ?? record.error);
    if (!reason) {
      return undefined;
    }

    return { valid: false, reason };
  }

  private readFailureReason(
    value: unknown,
  ): WispaceLinkVerifyFailureReason | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const normalized = value.trim().toUpperCase();
    return VERIFY_FAILURE_REASONS.find((reason) => reason === normalized);
  }

  private readPositiveInt(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }

    if (typeof value === 'string' && value.trim()) {
      const parsed = Number.parseInt(value.trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }

    return undefined;
  }
}
