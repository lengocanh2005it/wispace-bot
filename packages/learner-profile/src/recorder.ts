import { Logger } from '@nestjs/common';
import { errorMessage } from '@wispace/bot-common/masking';
import { extractFactsFromToolResult } from './extract-facts';
import type { LearnerProfileStorePort } from './learner-profile.store.port';
import type { LearnerIdentity } from './types';

/** Minimal shape of the agent's tool-result hook (structural, no chat-agent import). */
export interface ToolResultParams {
  toolName: string;
  result: unknown;
  context: LearnerIdentity;
}

export interface LearnerProfileRecorderOptions {
  /** Fired when the store write fails — defaults to a warn log. */
  onError?: (error: unknown, identity: LearnerIdentity) => void;
}

/**
 * Builds the `onToolResult` hook for the agent loop: extracts facts from
 * server-derived tool results and persists them best-effort. A store failure
 * is logged, never propagated — the chat flow must not depend on the profile.
 */
export function createLearnerProfileRecorder(
  store: LearnerProfileStorePort,
  platform: string,
  options: LearnerProfileRecorderOptions = {},
): (params: ToolResultParams) => void {
  const logger = new Logger('LearnerProfile');
  const onError =
    options.onError ??
    ((error: unknown) => {
      logger.warn(`failed to persist learner facts: ${errorMessage(error)}`);
    });

  return (params: ToolResultParams): void => {
    const facts = extractFactsFromToolResult(params.toolName, params.result);
    if (!facts) {
      return;
    }
    void store
      .upsert(
        platform,
        params.context.externalUserId,
        params.context.userId,
        facts,
      )
      .catch((error: unknown) => {
        onError(error, params.context);
      });
  };
}
