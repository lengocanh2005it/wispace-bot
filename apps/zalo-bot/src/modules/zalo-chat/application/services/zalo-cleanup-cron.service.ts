import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { CleanupCronService } from '@wispace/cleanup-cron';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { ZaloOauthStateEntity } from '../../../../infrastructure/database/entities/zalo-oauth-state.entity';

const OAUTH_STATE_LOCK_ID = 884_200_913;

@Injectable()
export class ZaloCleanupCronService {
  private readonly logger = new Logger(ZaloCleanupCronService.name);

  constructor(
    private readonly cleanupService: CleanupCronService,
    private readonly configService: ConfigService,
    @InjectRepository(ZaloOauthStateEntity)
    private readonly oauthStateRepo: Repository<ZaloOauthStateEntity>,
  ) {}

  @Cron('0 */10 * * * *', {
    name: 'zalo-oauth-state-cleanup',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleOAuthStateCleanup(): Promise<void> {
    await this.cleanupService.execute(
      {
        name: 'zalo-oauth-state-cleanup',
        advisoryLockId: OAUTH_STATE_LOCK_ID,
        cronExpression: '0 */10 * * * *',
        enabledConfigKey: 'ZALO_OAUTH_STATE_CLEANUP_ENABLED',
        retentionDaysConfigKey: 'ZALO_OAUTH_STATE_RETENTION_DAYS',
        defaultRetentionDays: 0, // 0 days = clean up immediately (states are ephemeral)
      },
      () => {
        // OAuth states expire quickly (5-10 min), so delete any older than 10 minutes
        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
        return this.oauthStateRepo
          .delete({ createdAt: LessThan(tenMinutesAgo) })
          .then((r) => r.affected ?? 0);
      },
      () => true, // Always enabled
      () => 0, // Not used, we hardcode 10 minutes
    );
  }
}
