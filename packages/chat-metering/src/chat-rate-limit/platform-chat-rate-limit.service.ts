import { InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import { ChatDailyUsageEntity } from '../entities/chat-daily-usage.entity';
import { ChatIdempotencyEntity } from '../entities/chat-idempotency.entity';
import { ChatRateLimitCore } from './chat-rate-limit-core.service';
import { ChatRateLimitRepository } from './chat-rate-limit.repository';
import { PostgresBurstCounter } from './postgres-burst-counter';
import type { ChatQuotaCheckResult, ChatRateLimitSettings } from './types';

export interface PlatformChatRateLimitOptions {
  /** Platform key for `(platform, external_user_id)` DB rows. */
  platform: string;
  /**
   * Strict config mode (discord): throw when `CHAT_FREE_FORM_DAILY_LIMIT` /
   * `CHAT_BURST_PER_MINUTE` / `CHAT_USAGE_TIMEZONE` are missing or invalid.
   * Otherwise fall back to defaults (15 / 3 / Asia/Ho_Chi_Minh) — zalo.
   */
  requireEnv?: boolean;
  /**
   * Accept `true`/`1`/`yes` for the `CHAT_RATE_LIMIT_ENABLED` and
   * `CHAT_BURST_COUNT_REFUNDED` flags (discord); otherwise require exactly
   * `'true'` — zalo.
   */
  lenientEnabledCheck?: boolean;
}

const DEFAULT_DAILY_LIMIT = 15;
const DEFAULT_BURST_PER_MINUTE = 3;
const DEFAULT_TIMEZONE = 'Asia/Ho_Chi_Minh';
const DEFAULT_STUCK_RESERVED_MS = 600_000;

/**
 * Thin NestJS adapter around `ChatRateLimitCore` + `PostgresBurstCounter`,
 * shared by the Discord and Zalo bots. Wires the same `CHAT_*` env keys used
 * by both apps and exposes the union of both apps' method surfaces
 * (`reserve`/`refund` + `reserveFreeFormSlot`/`refundFreeFormSlot` aliases).
 */
export class PlatformChatRateLimitService {
  private readonly logger = new Logger(PlatformChatRateLimitService.name);
  private readonly core: ChatRateLimitCore;
  private readonly enabled: boolean;
  private readonly platform: string;

  constructor(
    private readonly options: PlatformChatRateLimitOptions,
    configService: ConfigService,
    dailyUsageRepo: Repository<ChatDailyUsageEntity>,
    idempotencyRepo: Repository<ChatIdempotencyEntity>,
  ) {
    this.platform = options.platform;
    const strict = options.requireEnv === true;
    const lenient = options.lenientEnabledCheck === true;

    const enabledRaw = configService.get<string>('CHAT_RATE_LIMIT_ENABLED');
    this.enabled = lenient
      ? ['true', '1', 'yes'].includes(enabledRaw?.trim().toLowerCase() ?? '')
      : enabledRaw === 'true';

    const settings: ChatRateLimitSettings = {
      freeFormDailyLimit: strict
        ? this.readRequiredPositiveNumber(
            configService,
            'CHAT_FREE_FORM_DAILY_LIMIT',
          )
        : this.readNumberOrDefault(
            configService,
            'CHAT_FREE_FORM_DAILY_LIMIT',
            DEFAULT_DAILY_LIMIT,
          ),
      burstPerMinute: strict
        ? this.readRequiredPositiveNumber(
            configService,
            'CHAT_BURST_PER_MINUTE',
          )
        : this.readNumberOrDefault(
            configService,
            'CHAT_BURST_PER_MINUTE',
            DEFAULT_BURST_PER_MINUTE,
          ),
      timezone: strict
        ? this.readRequiredTimezone(configService)
        : (configService.get<string>('CHAT_USAGE_TIMEZONE') ??
          DEFAULT_TIMEZONE),
      burstCountsRefunded: lenient
        ? ['true', '1', 'yes'].includes(
            configService
              .get<string>('CHAT_BURST_COUNT_REFUNDED')
              ?.trim()
              .toLowerCase() ?? '',
          )
        : configService.get<string>('CHAT_BURST_COUNT_REFUNDED') === 'true',
    };

    const repository = new ChatRateLimitRepository(
      dailyUsageRepo,
      idempotencyRepo,
      options.platform,
    );

    this.core = new ChatRateLimitCore(
      repository,
      new PostgresBurstCounter(repository, settings.burstCountsRefunded),
      settings,
      {
        warn: (msg) => this.logger.warn(msg),
        log: (msg) => this.logger.log(msg),
      },
      this.readStuckReservedMs(configService),
    );

    // #299: fail closed when production quota enforcement is disabled
    this.checkProductionEnforcement(configService);
  }

  private checkProductionEnforcement(configService: ConfigService): void {
    const nodeEnv = configService.get<string>('NODE_ENV')?.trim();
    const enforce = configService
      .get<string>('ENFORCE_PROD_CHAT_QUOTA')
      ?.trim()
      .toLowerCase();
    const isProduction =
      nodeEnv === 'production' ||
      enforce === 'true' ||
      enforce === '1' ||
      enforce === 'yes';

    if (isProduction && !this.enabled) {
      throw new InternalServerErrorException(
        `CHAT_RATE_LIMIT_ENABLED must be true in production — quota enforcement is required for ${this.platform} (#299)`,
      );
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async reserve(
    externalUserId: string,
    idempotencyKey: string,
  ): Promise<ChatQuotaCheckResult> {
    return this.core.reserveFreeFormSlot(externalUserId, { idempotencyKey });
  }

  async reserveFreeFormSlot(
    externalUserId: string,
    params: { idempotencyKey: string },
  ): Promise<ChatQuotaCheckResult> {
    return this.reserve(externalUserId, params.idempotencyKey);
  }

  async refund(
    externalUserId: string,
    usageDate: string,
    idempotencyKey: string,
  ): Promise<void> {
    return this.core.refundFreeFormSlot(
      externalUserId,
      usageDate,
      idempotencyKey,
    );
  }

  async refundFreeFormSlot(
    externalUserId: string,
    usageDate: string,
    idempotencyKey: string,
  ): Promise<void> {
    return this.refund(externalUserId, usageDate, idempotencyKey);
  }

  async markCompleted(idempotencyKey: string): Promise<void> {
    return this.core.markCompleted(idempotencyKey);
  }

  async markDelivered(idempotencyKey: string): Promise<void> {
    return this.core.markDelivered(idempotencyKey);
  }

  async recoverStuckReservedSlots(): Promise<{ recovered: string[] }> {
    return this.core.recoverStuckReservedSlots();
  }

  private readNumberOrDefault(
    configService: ConfigService,
    key: string,
    fallback: number,
  ): number {
    const raw = configService.get<string>(key);
    if (!raw) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  }

  private readStuckReservedMs(configService: ConfigService): number {
    const raw = configService
      .get<string>('CHAT_IDEMPOTENCY_STUCK_RESERVED_MS')
      ?.trim();
    if (!raw) return DEFAULT_STUCK_RESERVED_MS;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0
      ? value
      : DEFAULT_STUCK_RESERVED_MS;
  }

  private readRequiredPositiveNumber(
    configService: ConfigService,
    key: string,
  ): number {
    const raw = configService.get<string>(key)?.trim();
    if (!raw) {
      throw new InternalServerErrorException(`${key} must be set in .env`);
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw new InternalServerErrorException(
        `${key} must be a positive number in .env`,
      );
    }
    return value;
  }

  private readRequiredTimezone(configService: ConfigService): string {
    const timezone = configService.get<string>('CHAT_USAGE_TIMEZONE')?.trim();
    if (!timezone) {
      throw new InternalServerErrorException(
        'CHAT_USAGE_TIMEZONE must be set in .env',
      );
    }
    return timezone;
  }
}
