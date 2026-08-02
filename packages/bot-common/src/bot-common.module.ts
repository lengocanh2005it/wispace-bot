import { Module } from '@nestjs/common';
import { InternalApiKeyGuard } from './internal-api-key.guard';
import { PgAdvisoryLockService } from './pg-advisory-lock.service';

/** Shared NestJS infra for all bots: ops API guard + advisory locks. */
@Module({
  providers: [InternalApiKeyGuard, PgAdvisoryLockService],
  exports: [InternalApiKeyGuard, PgAdvisoryLockService],
})
export class BotCommonModule {}
