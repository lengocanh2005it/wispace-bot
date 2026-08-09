import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CHAT_QUEUE_STORE } from '../../domain/repositories/chat-queue.store.port';
import type { ChatQueueStorePort } from '../../domain/repositories/chat-queue.store.port';
import { MessengerChatProcessorService } from './messenger-chat-processor.service';
import { MessengerChatSharedConfigService } from './messenger-chat-shared-config.service';

@Injectable()
export class MessengerChatQueueWorkerService {
  private readonly logger = new Logger(MessengerChatQueueWorkerService.name);

  constructor(
    private readonly sharedConfig: MessengerChatSharedConfigService,
    private readonly chatQueueService: MessengerChatProcessorService,
    @Inject(CHAT_QUEUE_STORE)
    private readonly chatQueueStore: ChatQueueStorePort,
  ) {}

  @Cron('*/2 * * * * *', {
    name: 'messenger-chat-queue-flush',
  })
  async pollReadyBuffers(): Promise<void> {
    if (!this.sharedConfig.isDistributedQueueEnabled()) {
      return;
    }

    // No cron lock: claim uses per-psid lock (Redis) or SELECT FOR UPDATE (postgres),
    // so all pods can poll in parallel and safely process different PSIDs.
    try {
      const psids = await this.chatQueueStore.listPsidsReadyForFlush(
        25,
        this.sharedConfig.getProcessingStuckMs(),
      );

      for (const psid of psids) {
        await this.chatQueueService.flushReady(psid);
      }
    } catch (error) {
      this.logger.error(
        `Shared chat queue poll failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
