import { type InjectionToken, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { REDIS_CLIENT, type RedisClientPort } from '@wispace/bot-common/redis';
import {
  createLearnerProfileRecorder,
  createLearnerProfileSuffix,
  LEARNER_PROFILE_STORE,
  TypeOrmLearnerProfileStore,
  type LearnerProfileStorePort,
} from '@wispace/learner-profile';
import {
  PlatformLlmSafetyEventAdapter,
  PlatformLlmUsageRecorderAdapter,
} from '@wispace/chat-metering/adapters';
import type { Platform } from '@wispace/contracts';
import type { LlmProviderAdapter } from '@wispace/llm-agent/core';

import { PlatformAgentService } from './agent/platform-agent.service';
import { PlatformAgentToolsService } from './agent/platform-agent-tools.service';
import type {
  PlatformAgentInput,
  PlatformAgentOptions,
  PlatformPromptSuffixParts,
} from './agent/platform-agent.types';
import { PlatformChatHistoryService } from './chat-history/platform-chat-history.service';
import { RedisChatQueueWorkerService } from './chat-queue/redis-chat-queue.worker';
import { ChatRuntimeConfig } from './chat-runtime-config';

/** Supplies the external ids whose buffered turn is ready to flush. */
export interface PlatformChatQueueReadySource {
  listReadyExternalUserIds(limit: number): Promise<string[]>;
  reconcile?(): Promise<unknown>;
}

/** Flushes one learner's buffered turn. */
export interface PlatformChatFlushSource {
  flushReady(externalUserId: string): Promise<void>;
}

/**
 * The agent options no factory can read, because each closes over a service only
 * its own bot resolves — the identity lookup, the tool metrics, the classifier,
 * the execution port. Every field is stated: `null` means "this bot has no such
 * hook", which is a decision, where an omitted field would be an accident.
 */
export type PlatformChatAgentDynamicOptions = Pick<
  PlatformAgentOptions,
  'currentIdentityProvider' | 'metrics'
> & {
  [K in Exclude<PlatformChatAgentHookKeys, 'systemPromptSuffix'>]-?:
    | PlatformAgentOptions[K]
    | null;
} & {
  /**
   * The bot's own prompt parts. Narrowed against the string form the
   * underlying option still allows: a mandatory suffix cannot be merged
   * with named parts, and silently dropping it would remove a learner's
   * name while the profile part still rendered.
   */
  systemPromptSuffix:
    | ((
        input: PlatformAgentInput,
      ) => Promise<PlatformPromptSuffixParts | undefined>)
    | null;
};

type PlatformChatAgentHookKeys =
  | 'clarificationStore'
  | 'clarificationOutcomeInc'
  | 'contentClassifier'
  | 'classifierUsage'
  | 'llmExecution'
  | 'llmAdmissionMetrics'
  | 'systemPromptSuffix'
  | 'onBeforeReply'
  | 'tryFastReschedule'
  | 'cancelPendingReschedule';

export interface CreatePlatformChatProvidersOptions {
  platform: Platform;
  historyEnvPrefix: string;
  historyKeyPrefix: string;
  promptDir: string;
  promptFile: string;
  toolExecutionTimeoutMs: number;
  appendHistory: boolean;
  queueWorkerReady: InjectionToken<PlatformChatQueueReadySource>;
  queueWorkerFlush: InjectionToken<PlatformChatFlushSource>;
  agentDynamicOptions: InjectionToken<PlatformChatAgentDynamicOptions>;
}

/**
 * The tokens this factory provides. The guard that keeps chat modules from
 * re-declaring them reads this list rather than its own copy, so the check and
 * the factory cannot disagree.
 */
export const PLATFORM_CHAT_PROVIDER_TOKENS = [
  PlatformChatHistoryService,
  PlatformAgentService,
  RedisChatQueueWorkerService,
  LEARNER_PROFILE_STORE,
] as const;

/**
 * Wires the part of the chat graph every bot shares: chat history, the agent,
 * the queue worker, and the learner-profile store. Everything a single bot
 * owns — its tool executor, queue service, confirmation service, cleanup crons —
 * stays in that bot's module and arrives here as a token.
 *
 * No option carries a default. A bot that needs a value states it, and a bot
 * with no equivalent hook passes `null` explicitly rather than inheriting
 * another bot's behaviour.
 */
export function createPlatformChatProviders(
  options: CreatePlatformChatProvidersOptions,
): Provider[] {
  const {
    platform,
    historyEnvPrefix,
    historyKeyPrefix,
    promptDir,
    promptFile,
    toolExecutionTimeoutMs,
    appendHistory,
    queueWorkerReady,
    queueWorkerFlush,
    agentDynamicOptions,
  } = options;

  return [
    {
      provide: LEARNER_PROFILE_STORE,
      useClass: TypeOrmLearnerProfileStore,
    },
    {
      provide: PlatformChatHistoryService,
      useFactory: (
        configService: ConfigService,
        runtimeConfig: ChatRuntimeConfig,
        redisClient?: RedisClientPort,
      ) =>
        new PlatformChatHistoryService(
          configService,
          { envPrefix: historyEnvPrefix, keyPrefix: historyKeyPrefix },
          redisClient,
          runtimeConfig,
        ),
      inject: [
        ConfigService,
        ChatRuntimeConfig,
        { token: REDIS_CLIENT, optional: true },
      ],
    },
    {
      provide: PlatformAgentService,
      useFactory: (
        configService: ConfigService,
        toolsService: PlatformAgentToolsService,
        historyService: PlatformChatHistoryService,
        usageRecorder: PlatformLlmUsageRecorderAdapter,
        safetyEventService: PlatformLlmSafetyEventAdapter,
        adapter: LlmProviderAdapter,
        learnerProfileStore: LearnerProfileStorePort,
        dynamic: PlatformChatAgentDynamicOptions,
        redisClient?: RedisClientPort,
      ) => {
        const learnerProfile = createLearnerProfileSuffix(
          learnerProfileStore,
          platform,
        );
        const agentSystemPromptSuffix = dynamic.systemPromptSuffix;

        return new PlatformAgentService(
          configService,
          toolsService,
          historyService,
          usageRecorder,
          safetyEventService,
          adapter,
          {
            platform,
            currentIdentityProvider: (externalUserId: string) =>
              dynamic.currentIdentityProvider(externalUserId),
            promptDir,
            promptFile,
            toolExecutionTimeoutMs,
            appendHistory,
            metrics: dynamic.metrics,
            clarificationStore: dynamic.clarificationStore ?? undefined,
            clarificationOutcomeInc:
              dynamic.clarificationOutcomeInc ?? undefined,
            contentClassifier: dynamic.contentClassifier ?? undefined,
            classifierUsage: dynamic.classifierUsage ?? undefined,
            llmExecution: dynamic.llmExecution ?? undefined,
            llmAdmissionMetrics: dynamic.llmAdmissionMetrics ?? undefined,
            onBeforeReply: dynamic.onBeforeReply ?? undefined,
            tryFastReschedule: dynamic.tryFastReschedule ?? undefined,
            cancelPendingReschedule:
              dynamic.cancelPendingReschedule ?? undefined,
            onToolResult: createLearnerProfileRecorder(
              learnerProfileStore,
              platform,
            ),
            systemPromptSuffix: async (input: PlatformAgentInput) => {
              const learnerProfileSection = await learnerProfile({
                externalUserId: input.externalUserId,
                userId: input.userId,
              });
              const ownParts = agentSystemPromptSuffix
                ? await agentSystemPromptSuffix(input)
                : undefined;
              const merged: PlatformPromptSuffixParts = {
                ...ownParts,
                ...(learnerProfileSection
                  ? { learnerProfile: learnerProfileSection }
                  : {}),
              };
              return Object.keys(merged).length > 0 ? merged : undefined;
            },
          } satisfies PlatformAgentOptions,
          redisClient,
        );
      },
      inject: [
        ConfigService,
        PlatformAgentToolsService,
        PlatformChatHistoryService,
        PlatformLlmUsageRecorderAdapter,
        PlatformLlmSafetyEventAdapter,
        'LLM_PROVIDER_ADAPTER',
        LEARNER_PROFILE_STORE,
        agentDynamicOptions,
        REDIS_CLIENT,
      ],
    },
    {
      provide: RedisChatQueueWorkerService,
      useFactory: (
        configService: ConfigService,
        runtimeConfig: ChatRuntimeConfig,
        ready: PlatformChatQueueReadySource,
        flush: PlatformChatFlushSource,
      ) =>
        new RedisChatQueueWorkerService(
          configService,
          (limit: number) => ready.listReadyExternalUserIds(limit),
          (externalUserId: string) => flush.flushReady(externalUserId),
          ready.reconcile ? () => ready.reconcile!() : undefined,
          runtimeConfig,
        ),
      inject: [
        ConfigService,
        ChatRuntimeConfig,
        queueWorkerReady,
        queueWorkerFlush,
      ],
    },
  ];
}
