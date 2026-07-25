import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LlmAgentService,
  LlmAgentPorts,
  ToolExecutorPort,
  loadSystemPromptFile,
  type LlmProviderAdapter,
} from '@wispace/llm-agent';
import { join } from 'path';
import { trace } from '@opentelemetry/api';
import { UserDisplayNameService } from '../../../study-reminder/application/services/user-display-name.service';
import {
  MessengerAgentToolsService,
  MessengerAgentToolContext,
} from './messenger-agent-tools.service';
import { LlmSafetyEventService } from '../../../llm-safety/application/services/llm-safety-event.service';
import { LlmExecutionService } from '../../../llm-execution/application/services/llm-execution.service';
import type { LlmExecutionContext } from '../../../llm-execution/application/types/llm-execution.types';
import { LlmUsageRecorderService } from '../../../llm-usage/application/services/llm-usage-recorder.service';
import { MetricsService } from '../../../metrics/metrics.service';
import type {
  MessengerAgentReply,
  MessengerAgentStreamEvent,
  MessengerAgentInput,
} from './messenger-agent.types';

export type {
  MessengerAgentReply,
  MessengerAgentStreamEvent,
  MessengerAgentInput,
} from './messenger-agent.types';

/**
 * Thin NestJS adapter around the platform-agnostic `@wispace/llm-agent` orchestration
 * loop. Owns: Messenger-specific ports (usage/safety/metrics/tool execution wiring),
 * system prompt composition (base prompt + per-user linkage note), and the
 * MessengerAgentReply shape (text + richFollowUps) consumed by MessengerChatQueueService.
 */
@Injectable()
export class MessengerAgentService {
  private readonly logger = new Logger(MessengerAgentService.name);
  private readonly promptDir = join(__dirname, '../../../../shared/prompts');
  private agent?: LlmAgentService<MessengerAgentToolContext>;

  constructor(
    private readonly configService: ConfigService,
    private readonly toolsService: MessengerAgentToolsService,
    private readonly userDisplayNameService: UserDisplayNameService,
    private readonly llmUsageRecorder: LlmUsageRecorderService,
    private readonly llmExecution: LlmExecutionService,
    private readonly llmSafetyEventService: LlmSafetyEventService,
    private readonly metrics: MetricsService,
    @Inject('LLM_PROVIDER_ADAPTER')
    private readonly adapter: LlmProviderAdapter,
  ) {}

  async reply(input: MessengerAgentInput): Promise<MessengerAgentReply> {
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      activeSpan.setAttributes({
        'messenger.psid': input.psid,
        'messenger.user_id': input.userId ?? 0,
        'llm.feature': 'FREE_FORM_CHAT',
      });
    }

    const displayName = await this.userDisplayNameService.resolveDisplayName({
      psid: input.psid,
      userId: input.userId,
    });

    const toolContext: MessengerAgentToolContext = {
      psid: input.psid,
      userId: input.userId,
      linkContext: input.linkContext,
      richFollowUps: [],
    };

    const fastReschedule = await this.toolsService.tryFastDefaultReschedule(
      toolContext,
      input.userText,
    );
    if (fastReschedule) {
      return fastReschedule;
    }

    if (!this.agent) {
      this.agent = this.buildAgent();
    }
    const result = await this.agent.reply(
      {
        externalUserId: input.psid,
        userId: input.userId,
        userText: input.userText,
        systemPrompt: this.buildSystemPrompt(displayName, input.userId),
        history: input.history,
        correlationId: input.correlationId,
      },
      toolContext,
    );

    return {
      text: result.text,
      richFollowUps: toolContext.richFollowUps,
      exhausted: result.exhausted,
      toolSummary: result.toolSummary,
    };
  }

  async *replyStream(
    input: MessengerAgentInput,
  ): AsyncIterable<MessengerAgentStreamEvent> {
    const toolContext: MessengerAgentToolContext = {
      psid: input.psid,
      userId: input.userId,
      linkContext: input.linkContext,
      richFollowUps: [],
    };

    const fastReschedule = await this.toolsService.tryFastDefaultReschedule(
      toolContext,
      input.userText,
    );
    if (fastReschedule) {
      yield { type: 'delta', textDelta: fastReschedule.text };
      yield {
        type: 'done',
        reply: {
          text: fastReschedule.text,
          richFollowUps: toolContext.richFollowUps,
          exhausted: fastReschedule.exhausted,
          toolSummary: fastReschedule.toolSummary,
        },
      };
      return;
    }

    const displayName = await this.userDisplayNameService.resolveDisplayName({
      psid: input.psid,
      userId: input.userId,
    });

    if (!this.agent) {
      this.agent = this.buildAgent();
    }

    for await (const event of this.agent.replyStream(
      {
        externalUserId: input.psid,
        userId: input.userId,
        userText: input.userText,
        systemPrompt: this.buildSystemPrompt(displayName, input.userId),
        history: input.history,
        correlationId: input.correlationId,
      },
      toolContext,
    )) {
      if (event.type === 'done') {
        yield {
          type: 'done',
          reply: {
            text: event.reply.text,
            richFollowUps: toolContext.richFollowUps,
            exhausted: event.reply.exhausted,
            toolSummary: event.reply.toolSummary,
          },
        };
      } else {
        yield event;
      }
    }
  }

  private buildAgent(): LlmAgentService<MessengerAgentToolContext> {
    const toolExecutor: ToolExecutorPort<MessengerAgentToolContext> = {
      execute: (toolName, argsJson, ctx) =>
        this.metrics.timeTool(toolName, () =>
          this.toolsService.execute(toolName, argsJson, ctx),
        ),
    };

    const ports: LlmAgentPorts<MessengerAgentToolContext> = {
      llmExecution: {
        run: (fn, meta) =>
          this.llmExecution.run(fn, meta as LlmExecutionContext),
      },
      usageRecorder: {
        recordFromCompletion: (params) =>
          this.llmUsageRecorder.recordFromCompletion({
            feature: 'FREE_FORM_CHAT',
            psid: params.externalUserId,
            userId: params.userId,
            model: params.model,
            response: params.response as Parameters<
              LlmUsageRecorderService['recordFromCompletion']
            >[0]['response'],
            correlationId: params.correlationId,
            toolRound: params.toolRound,
          }),
      },
      safetyEvents: {
        recordGroundingWarning: (params) =>
          this.llmSafetyEventService.recordGroundingWarning({
            psid: params.externalUserId,
            userId: params.userId,
            correlationId: params.correlationId,
            reason: params.reason,
            userTextPreview: params.userTextPreview,
            assistantTextPreview: params.assistantTextPreview,
            toolNamesUsed: params.toolNamesUsed,
          }),
      },
      metrics: {
        timeLlmCall: (feature, model, round, fn) =>
          this.metrics.timeLlmCall(feature, model, round, fn),
        timeTool: (toolName, fn) => this.metrics.timeTool(toolName, fn),
        llmRoundOutcomeInc: (feature, outcome) =>
          this.metrics.llmRoundOutcome.inc({ feature, outcome }),
      },
      toolExecutor,
      adapter: this.adapter,
      logger: {
        warn: (message) => this.logger.warn(message),
        debug: (message) => this.logger.debug(message),
      },
    };

    return new LlmAgentService<MessengerAgentToolContext>(
      {
        maxToolRounds: Number(
          this.configService.get<string>('OPENAI_MAX_TOOL_ROUNDS'),
        ),
        maxContextChars: Number(
          this.configService.get<string>('OPENAI_MAX_CONTEXT_CHARS'),
        ),
        maxOutputTokens: Number(
          this.configService.get<string>('OPENAI_MAX_OUTPUT_TOKENS'),
        ),
        // Disable agent-level retry — LlmExecutionService already handles retries
        // with proper timeout and concurrency control. Stacking causes 9x attempts.
        maxLlmRetries: 0,
      },
      ports,
    );
  }

  private buildSystemPrompt(displayName: string, userId?: number): string {
    const base = loadSystemPromptFile(
      this.promptDir,
      'messenger-chat.system.txt',
    );
    const linkage = userId
      ? `Học viên đã liên kết WISPACE (userId=${userId}). Tên gọi: ${displayName}.`
      : `Học viên chưa liên kết WISPACE. Tên gọi: ${displayName}. Nhắc mở Messenger từ link trong app WISPACE nếu cần dữ liệu cá nhân.`;

    return `${base}\n\n${linkage}`;
  }
}
