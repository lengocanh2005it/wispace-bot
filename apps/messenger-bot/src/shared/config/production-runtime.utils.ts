import { ConfigService } from '@nestjs/config';
import {
  validateUpstreamUrl,
  buildUpstreamUrlPolicy,
} from '@wispace/wispace-client';

export function isTestRuntime(configService: ConfigService): boolean {
  return configService.get<string>('NODE_ENV')?.trim() === 'test';
}

/** Production or VPS with ENFORCE_PROD_CHAT_QUOTA — stricter startup checks. */
export function isStrictProductionRuntime(
  configService: ConfigService,
): boolean {
  if (isTestRuntime(configService)) {
    return false;
  }

  const nodeEnv = configService.get<string>('NODE_ENV')?.trim();
  if (nodeEnv === 'production') {
    return true;
  }

  const enforce = configService
    .get<string>('ENFORCE_PROD_CHAT_QUOTA')
    ?.trim()
    .toLowerCase();

  return enforce === 'true' || enforce === '1' || enforce === 'yes';
}

/**
 * Shared verify-token URL — same endpoint for all 3 bots (payload: { token, value, platform }).
 * Fail-closed: an unsafe (non-HTTPS / credential / fragment / prod private-target / non-allowlisted)
 * URL is rejected at startup instead of silently sending the internal key and link tokens elsewhere.
 */
export function readWispaceVerifyTokenUrl(
  configService: ConfigService,
): string | undefined {
  const url =
    configService.get<string>('WISPACE_API_VERIFY_TOKEN_URL')?.trim() ||
    undefined;

  if (!url) {
    return undefined;
  }

  return validateUpstreamUrl(
    url,
    buildUpstreamUrlPolicy('WISPACE_API_VERIFY_TOKEN_URL', configService),
  );
}
