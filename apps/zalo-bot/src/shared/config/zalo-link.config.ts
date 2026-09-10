import type { ConfigService } from '@nestjs/config';
import { readPositiveInteger } from '@wispace/account-link-core/core';

const DEFAULT_REWELCOME_WINDOW_MS = 86_400_000;
const DEFAULT_WELCOME_CLAIM_MS = 60_000;

export function readZaloRewelcomeWindowMs(
  configService: ConfigService,
): number {
  return readPositiveInteger(
    configService.get<string>('ZALO_REWELCOME_WINDOW_MS'),
    DEFAULT_REWELCOME_WINDOW_MS,
  );
}

export function readZaloWelcomeClaimMs(configService: ConfigService): number {
  return readPositiveInteger(
    configService.get<string>('ZALO_WELCOME_CLAIM_MS'),
    DEFAULT_WELCOME_CLAIM_MS,
  );
}
