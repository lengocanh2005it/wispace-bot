import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import type { Provider } from '@nestjs/common';
import type { Platform } from '@wispace/contracts';
import {
  RescheduleConfirmationAttemptEntity,
  RescheduleConfirmationEntity,
} from '@wispace/database';
import { BotMetricsService } from '@wispace/bot-metrics';
import {
  ADVISORY_LOCKS,
  PgAdvisoryLockService,
} from '@wispace/bot-common/locks';
import { TypeormRescheduleStore } from './typeorm-reschedule-store';
import { TypeormRescheduleAttemptStore } from './typeorm-reschedule-attempt-store';
import { RescheduleRecoveryCronService } from './reschedule-recovery-cron.service';

/**
 * The two reschedule providers every bot wires, identical except for the
 * platform string. All three bots (Messenger, Discord, Zalo) share one global
 * `reschedule_confirmations` table and one advisory lock, so a fourth copy of
 * this block was a place where the lock id or the recovery wiring could drift
 * without any test failing.
 *
 * The platform is passed explicitly rather than read from an ambient
 * `PLATFORMS` lookup so a bot cannot register the store under another's
 * platform by accident.
 */
export function createRescheduleProviders(platform: Platform): Provider[] {
  return [
    {
      provide: TypeormRescheduleStore,
      useFactory: (repo: Repository<RescheduleConfirmationEntity>) =>
        new TypeormRescheduleStore<string>(platform, repo),
      inject: [getRepositoryToken(RescheduleConfirmationEntity)],
    },
    {
      provide: TypeormRescheduleAttemptStore,
      useFactory: (repo: Repository<RescheduleConfirmationAttemptEntity>) =>
        new TypeormRescheduleAttemptStore(repo),
      inject: [getRepositoryToken(RescheduleConfirmationAttemptEntity)],
    },
    {
      provide: RescheduleRecoveryCronService,
      useFactory: (
        store: TypeormRescheduleStore<string>,
        metrics: BotMetricsService,
        pgLock: PgAdvisoryLockService,
        attemptStore: TypeormRescheduleAttemptStore,
      ) =>
        new RescheduleRecoveryCronService(
          store,
          metrics,
          {
            pgLock,
            lockId: ADVISORY_LOCKS.RESCHEDULE_RECOVERY,
          },
          attemptStore,
        ),
      inject: [
        TypeormRescheduleStore,
        BotMetricsService,
        PgAdvisoryLockService,
        TypeormRescheduleAttemptStore,
      ],
    },
  ];
}
