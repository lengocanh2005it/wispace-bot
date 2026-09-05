import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { maskExternalId, sanitizeLogValue } from '@wispace/bot-common/masking';
import { readResponseText } from '@wispace/bot-common/utils';
import {
  isValidCadence,
  normalizeCadence,
  POC_DEFAULT_LINK_CADENCE,
  POC_DEFAULT_LINK_TOPIC,
} from '@messenger/shared/config/poc.constants';
import { readWispaceVerifyTokenUrl } from '@messenger/shared/config/production-runtime.utils';
import type {
  MessengerLinkVerifyFailureReason,
  MessengerLinkVerifyResult,
} from '../../domain/types/messenger-link-verify.types';
import { keepAliveFetch } from '@messenger/shared/http/http-agent';
import { BotMetricsService } from '@wispace/bot-metrics';

const VERIFY_FAILURE_REASONS: MessengerLinkVerifyFailureReason[] = [
  'NOT_FOUND',
  'EXPIRED',
  'USED',
  'INVALID_FORMAT',
];

@Injectable()
export class WispaceMessengerTokenVerifyService {
  private readonly logger = new Logger(WispaceMessengerTokenVerifyService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly metrics?: BotMetricsService,
  ) {}

  async verifyMessengerToken(
    psid: string,
    token: string,
  ): Promise<MessengerLinkVerifyResult> {
    const call = () => this.verifyMessengerTokenUnmeasured(psid, token);
    return (
      this.metrics?.timeWispaceCall('TokenVerify', 'verify', call) ?? call()
    );
  }

  private async verifyMessengerTokenUnmeasured(
    psid: string,
    token: string,
  ): Promise<MessengerLinkVerifyResult> {
    const url = this.getVerifyUrl();
    const response = await keepAliveFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': this.getInternalKey(),
      },
      body: JSON.stringify({
        token: token.trim(),
        value: psid.trim(),
        platform: 'messenger',
      }),
      timeoutMs: 10_000,
    });

    const payload: unknown = await this.readJsonBody(response);

    if (response.ok) {
      return this.parseSuccessPayload(payload);
    }

    const failure = this.parseFailurePayload(payload);
    if (failure) {
      return failure;
    }

    throw new InternalServerErrorException(
      `WISPACE verify-messenger-token failed: HTTP ${response.status} ${response.statusText}`,
    );
  }

  private getVerifyUrl(): string {
    const url = readWispaceVerifyTokenUrl(this.configService);
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

  private parseSuccessPayload(payload: unknown): MessengerLinkVerifyResult {
    if (!payload || typeof payload !== 'object') {
      throw new InternalServerErrorException(
        'WISPACE verify-messenger-token returned invalid JSON body',
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
        'WISPACE verify-messenger-token missing userId in success response',
      );
    }

    const topic =
      typeof record.topic === 'string' && record.topic.trim()
        ? record.topic.trim()
        : POC_DEFAULT_LINK_TOPIC;
    const cadenceRaw =
      typeof record.cadence === 'string' && record.cadence.trim()
        ? record.cadence.trim()
        : POC_DEFAULT_LINK_CADENCE;

    if (!isValidCadence(cadenceRaw)) {
      throw new InternalServerErrorException(
        `WISPACE verify-messenger-token returned invalid cadence: ${String(record.cadence)}`,
      );
    }

    const username =
      typeof record.username === 'string' ? record.username.trim() : undefined;
    if (username) {
      this.logger.log(
        `WISPACE verify-messenger-token OK userId=${maskExternalId(
          userId,
        )} username=${maskExternalId(sanitizeLogValue(username, 64))}`,
      );
    } else {
      this.logger.log(
        `WISPACE verify-messenger-token OK userId=${maskExternalId(userId)}`,
      );
    }

    return {
      valid: true,
      userId,
      topic,
      cadence: normalizeCadence(cadenceRaw),
    };
  }

  private parseFailurePayload(
    payload: unknown,
  ): MessengerLinkVerifyResult | undefined {
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
  ): MessengerLinkVerifyFailureReason | undefined {
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
