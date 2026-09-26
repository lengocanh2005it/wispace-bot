import type {
  AgentPort,
  HistoryPort,
  OutboundPort,
  RateLimiterPort,
} from '@wispace/chat-pipeline';

/**
 * The four `ChatPipeline` adapters for Messenger (#1088). They are built by
 * `createMessengerChatPipelineAdapters` in
 * `infrastructure/adapters/messenger-chat-pipeline-adapters.ts` and bound in
 * `chat-pipeline.module.ts`, so the processor consumes the pipeline's own
 * public contract instead of importing the adapter factory itself.
 */
export interface MessengerChatPipelinePorts {
  rateLimiter: RateLimiterPort;
  history: HistoryPort;
  agent: AgentPort;
  outbound: OutboundPort;
}

export const MESSENGER_CHAT_PIPELINE_PORTS = Symbol(
  'MESSENGER_CHAT_PIPELINE_PORTS',
);
