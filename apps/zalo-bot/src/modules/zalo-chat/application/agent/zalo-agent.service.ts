import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LlmAgentService,
  LlmAgentPorts,
  NOOP_METRICS_PORT,
  ToolExecutorPort,
  type LlmProviderAdapter,
  loadSystemPromptFile,
} from '@wispace/llm-agent';
import type {
  ZaloAgentInput,
  ZaloAgentReply,
  ZaloAgentToolContext,
} from '../../domain/entities/zalo-chat.types';
import { ZaloAgentToolsService } from './zalo-agent-tools.service';
import { ZaloChatHistoryService } from '../services/zalo-chat-history.service';

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_BACKOFF_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thin NestJS adapter around @wispace/llm-agent's platform-agnostic
 * orchestration loop — Zalo counterpart to DiscordAgentService/
 * MessengerAgentService. No usage/safety recording in this MVP (no
 * packages/chat-metering wiring — see spec §1/Global Constraints).
 */
@Injectable()
export class ZaloAgentService {
  private readonly logger = new Logger(ZaloAgentService.name);
  private readonly promptDir = `${process.cwd()}/src/shared/prompts`;
  private agent?: LlmAgentService<ZaloAgentToolContext>;

  constructor(
    private readonly configService: ConfigService,
    private readonly toolsService: ZaloAgentToolsService,
    private readonly historyService: ZaloChatHistoryService,
    @Inject('LLM_PROVIDER_ADAPTER')
    private readonly adapter: LlmProviderAdapter,
  ) {}

  async reply(input: ZaloAgentInput): Promise<ZaloAgentReply> {
    if (!this.agent) {
      this.agent = this.buildAgent();
    }

    const toolContext: ZaloAgentToolContext = {
      zaloUserId: input.zaloUserId,
      userId: input.userId,
    };

    const history = await this.historyService.getHistory(input.zaloUserId);

    const result = await this.agent.reply(
      {
        externalUserId: input.zaloUserId,
        userId: input.userId,
        userText: input.userText,
        systemPrompt: this.buildSystemPrompt(),
        history,
        correlationId: input.correlationId,
      },
      toolContext,
    );

    await this.historyService.appendTurn(
      input.zaloUserId,
      input.userText,
      result.text,
    );

    return { text: result.text };
  }

  private buildAgent(): LlmAgentService<ZaloAgentToolContext> {
    const toolExecutor: ToolExecutorPort<ZaloAgentToolContext> = {
      execute: (toolName, argsJson, ctx) =>
        this.toolsService.execute(toolName, argsJson, ctx),
    };

    const ports: LlmAgentPorts<ZaloAgentToolContext> = {
      llmExecution: { run: (fn) => this.runWithRetry(fn) },
      usageRecorder: {
        recordFromCompletion: (event) => {
          this.logger.log(
            `LLM usage: feature=${event.feature} model=${event.model} toolRound=${event.toolRound} user=${event.externalUserId}`,
          );
        },
      },
      safetyEvents: {
        recordGroundingWarning: (event) => {
          this.logger.warn(
            `LLM safety grounding warning: user=${event.externalUserId} reason=${event.reason}`,
          );
        },
      },
      metrics: NOOP_METRICS_PORT,
      toolExecutor,
      adapter: this.adapter,
      logger: {
        warn: (message) => this.logger.warn(message),
        debug: (message) => this.logger.debug(message),
      },
    };

    return new LlmAgentService<ZaloAgentToolContext>(
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
      },
      ports,
    );
  }

  private async runWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (
          !this.adapter.isRetryableError(error) ||
          attempt >= RETRY_MAX_ATTEMPTS
        ) {
          throw error;
        }
        const backoffMs = RETRY_BASE_BACKOFF_MS * attempt;
        this.logger.warn(
          `LLM provider retry attempt=${attempt}/${RETRY_MAX_ATTEMPTS} backoffMs=${backoffMs}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await sleep(backoffMs);
      }
    }

    throw lastError;
  }

  private buildSystemPrompt(): string {
    return loadSystemPromptFile(this.promptDir, 'zalo-chat.system.txt');
  }
}
