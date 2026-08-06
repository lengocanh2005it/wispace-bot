import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  readEnvBoolean,
  readEnvPositiveInt,
  readRequiredPositiveNumber,
} from '@messenger/shared/config/env-helpers';
import type { ChatRateLimitSettings } from '../../domain/entities/chat-quota.types';
import type { ChatBurstStoreKind } from '../../domain/entities/chat-burst.types';
import { resolveAppTimezone } from '@messenger/shared/config/app-timezone';

@Injectable()
export class ChatRateLimitConfigService {
  constructor(private readonly configService: ConfigService) {}

  getSettings(): ChatRateLimitSettings {
    return {
      enabled: this.isEnabled(),
      freeFormDailyLimit: this.getFreeFormDailyLimit(),
      burstPerMinute: this.getBurstPerMinute(),
      timezone: this.getTimezone(),
      whitelistedPsids: this.getWhitelistedPsids(),
      remainingHintThreshold: this.getRemainingHintThreshold(),
      stuckReservedMs: this.getStuckReservedMs(),
      mergedTextMaxChars: this.getMergedTextMaxChars(),
      burstCountsRefunded: this.getBurstCountsRefunded(),
    };
  }

  isWhitelisted(psid: string): boolean {
    return this.getWhitelistedPsids().includes(psid);
  }

  shouldEnforceForPsid(psid: string): boolean {
    return this.isEnabled() && !this.isWhitelisted(psid);
  }

  isEnabled(): boolean {
    return readEnvBoolean(this.configService, 'CHAT_RATE_LIMIT_ENABLED', false);
  }

  getFreeFormDailyLimit(): number {
    return readRequiredPositiveNumber(
      this.configService,
      'CHAT_FREE_FORM_DAILY_LIMIT',
    );
  }

  getBurstPerMinute(): number {
    return readRequiredPositiveNumber(
      this.configService,
      'CHAT_BURST_PER_MINUTE',
    );
  }

  getTimezone(): string {
    return resolveAppTimezone(this.configService);
  }

  getWhitelistedPsids(): string[] {
    const raw = this.configService
      .get<string>('CHAT_RATE_LIMIT_WHITELIST_PSIDS')
      ?.trim();
    if (!raw) return [];
    return raw
      .split(',')
      .map((psid) => psid.trim())
      .filter((psid) => psid.length > 0);
  }

  getRemainingHintThreshold(): number {
    return readRequiredPositiveNumber(
      this.configService,
      'CHAT_QUOTA_REMAINING_HINT_THRESHOLD',
    );
  }

  getStuckReservedMs(): number {
    return readEnvPositiveInt(
      this.configService,
      'CHAT_IDEMPOTENCY_STUCK_RESERVED_MS',
      600_000,
    );
  }

  getMergedTextMaxChars(): number {
    return readEnvPositiveInt(
      this.configService,
      'CHAT_MERGED_TEXT_MAX_CHARS',
      4000,
    );
  }

  getBurstCountsRefunded(): boolean {
    return readEnvBoolean(
      this.configService,
      'CHAT_BURST_COUNT_REFUNDED',
      false,
    );
  }

  isQuotaEventsEnabled(): boolean {
    return readEnvBoolean(
      this.configService,
      'CHAT_QUOTA_EVENTS_ENABLED',
      true,
    );
  }

  getQuotaEventsRetentionDays(): number {
    return readEnvPositiveInt(
      this.configService,
      'CHAT_QUOTA_EVENTS_RETENTION_DAYS',
      365,
    );
  }

  getBurstStore(): ChatBurstStoreKind {
    const raw = this.configService
      .get<string>('CHAT_BURST_STORE')
      ?.trim()
      .toLowerCase();
    if (raw === 'memory' || raw === 'postgres' || raw === 'redis') return raw;
    return 'postgres';
  }
}
