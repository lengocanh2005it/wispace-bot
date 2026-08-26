import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { errorMessage } from '@wispace/bot-common/masking';
import { runBatched } from '@wispace/scheduler-core';

const POLL_MS = 2000;
const POLL_LIMIT = 25;
const FLUSH_CONCURRENCY = 3;

@Injectable()
export class RedisChatQueueWorkerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RedisChatQueueWorkerService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly configService: ConfigService,
    private readonly listReadyExternalUserIds: (
      limit: number,
    ) => Promise<string[]>,
    private readonly flushReady: (externalUserId: string) => Promise<void>,
  ) {}

  onModuleInit(): void {
    if (!this.isDistributedQueueEnabled()) {
      return;
    }
    this.timer = setInterval(() => void this.pollReadyBuffers(), POLL_MS);
    void this.pollReadyBuffers();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async pollReadyBuffers(): Promise<void> {
    if (!this.isDistributedQueueEnabled()) {
      return;
    }

    try {
      const externalUserIds = await this.listReadyExternalUserIds(POLL_LIMIT);
      await runBatched(externalUserIds, FLUSH_CONCURRENCY, (externalUserId) =>
        this.flushReady(externalUserId),
      );
    } catch (error) {
      this.logger.error(
        `Shared chat queue poll failed: ${errorMessage(error)}`,
      );
    }
  }

  private isDistributedQueueEnabled(): boolean {
    const store =
      this.configService
        .get<string>('CHAT_QUEUE_STORE')
        ?.trim()
        .toLowerCase() ??
      (this.configService
        .get<string>('CHAT_QUEUE_SHARED')
        ?.trim()
        .toLowerCase() === 'true'
        ? 'redis'
        : 'memory');
    return store === 'redis';
  }
}
