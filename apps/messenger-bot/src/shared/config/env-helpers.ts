import { InternalServerErrorException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
export { readEnvBoolean, readEnvPositiveInt } from '@wispace/bot-common/config';

/**
 * Read an env var, trim it, and parse as a positive integer.
 * Throws if the var is missing, empty, zero, negative, or non-numeric.
 */
export function readRequiredPositiveNumber(
  configService: Pick<ConfigService, 'get'>,
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
