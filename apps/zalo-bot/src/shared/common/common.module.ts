import { Module } from '@nestjs/common';
import {
  InternalApiKeyGuard,
  PgAdvisoryLockService,
} from '@wispace/bot-common';

@Module({
  providers: [InternalApiKeyGuard, PgAdvisoryLockService],
  exports: [InternalApiKeyGuard, PgAdvisoryLockService],
})
export class CommonModule {}
