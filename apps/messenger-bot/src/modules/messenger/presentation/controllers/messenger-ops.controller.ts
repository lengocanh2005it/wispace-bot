import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Optional,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';
import { InternalApiKeyGuard } from '@wispace/bot-common/guard';
import {
  PrivacyActionBody,
  setPrivacyResponseStatus,
  type PrivacyResponse,
} from '@wispace/bot-common/health';
import { RedisUserDisplayNameCache } from '@wispace/bot-common/redis';
import { PlatformChatHistoryService } from '@wispace/chat-agent';
import { BotMetricsService } from '@wispace/bot-metrics';
import { MessengerMappingService } from '../../application/services/messenger-mapping.service';
import { MessengerChatEnqueueService } from '../../application/services/messenger-chat-enqueue.service';
import {
  PRIVACY_CLEANUP_STORES,
  PRIVACY_DATA,
  type PrivacyDataPort,
  type PrivacyStateCleanup,
} from '../../application/chat-processing-seams.port';
import {
  AGENT_REPLY,
  type AgentReplyPort,
} from '../../application/ports/agent-reply.port';

class RelinkMappingBody {
  @IsString()
  psid!: string;

  @IsNumber()
  @IsPositive()
  userId!: number;

  @IsOptional()
  @IsBoolean()
  allowRelink?: boolean;
}

/**
 * The messenger half of the ops surface: account linking, clarification
 * recovery, and privacy actions. These routes used to live on
 * `SchedulerController`, which made the scheduler depend on the messenger
 * feature module in order to expose messenger's own endpoints (#1446).
 *
 * The `messenger` path prefix is unchanged, so every URL is the same.
 */
@Controller('messenger')
@UseGuards(InternalApiKeyGuard, ThrottlerGuard)
export class MessengerOpsController {
  constructor(
    private readonly messengerMappingService: MessengerMappingService,
    @Inject(PRIVACY_DATA)
    private readonly privacyService: PrivacyDataPort,
    @Inject(AGENT_REPLY)
    private readonly clarificationAgent: AgentReplyPort,
    private readonly historyService: PlatformChatHistoryService,
    private readonly chatEnqueueService: MessengerChatEnqueueService,
    private readonly displayNameCache: RedisUserDisplayNameCache,
    @Optional()
    private readonly metrics?: BotMetricsService,
  ) {}

  @Post('mapping/relink')
  @HttpCode(200)
  relinkMessengerMapping(@Body() body: RelinkMappingBody) {
    return this.messengerMappingService
      .relinkPsidToUserId({
        psid: body.psid,
        userId: body.userId,
        notifyUser: false,
        allowRelink: body.allowRelink === true,
      })
      .then(async (result) => {
        await this.clarificationAgent.clearClarificationState(body.psid);
        return result;
      });
  }

  @Post('ops/clarification/clear')
  @HttpCode(204)
  async clearClarificationState(@Body() body: PrivacyActionBody) {
    await this.clarificationAgent.clearClarificationState(body.externalUserId);
  }

  @Post('privacy/unlink')
  @HttpCode(200)
  async unlinkUser(
    @Body() body: PrivacyActionBody,
    @Res({ passthrough: true }) response?: PrivacyResponse,
  ) {
    const result = await this.privacyService.unlink(
      'messenger',
      body.externalUserId,
      this.privacyCleanup('unlink'),
      body.expectedMapping,
    );
    setPrivacyResponseStatus(response, result);
    return result;
  }

  @Post('privacy/delete')
  @HttpCode(200)
  async deleteUser(
    @Body() body: PrivacyActionBody,
    @Res({ passthrough: true }) response?: PrivacyResponse,
  ) {
    const result = await this.privacyService.delete(
      'messenger',
      body.externalUserId,
      this.privacyCleanup('delete'),
      body.expectedMapping,
    );
    setPrivacyResponseStatus(response, result);
    return result;
  }

  @Post('privacy/export')
  @HttpCode(200)
  exportUser(@Body() body: PrivacyActionBody) {
    return this.privacyService.export('messenger', body.externalUserId);
  }

  private privacyCleanup(operation: 'unlink' | 'delete'): PrivacyStateCleanup {
    return {
      platform: 'messenger',
      applicableStores: PRIVACY_CLEANUP_STORES,
      clearHistory: (id) => this.historyService.clear(id),
      clearQueuedWork: (id) => this.chatEnqueueService.clear(id),
      clearClarification: (id) =>
        this.clarificationAgent.clearClarificationState(id),
      clearUserCache: (userId: number) =>
        this.displayNameCache.delStrict(userId),
      onAttempt: (store, outcome) =>
        this.metrics?.incPrivacyCleanupAttempt(
          'messenger',
          operation,
          store,
          outcome,
        ),
    };
  }
}
