import { errorMessage } from '@wispace/bot-common';
import type { LlmSafetyEventRepository } from './llm-safety.repository';
import type { RecordGroundingWarningInput } from './types';

export interface LlmSafetyLogger {
  warn(message: string): void;
  log(message: string): void;
}

const NOOP_LOGGER: LlmSafetyLogger = {
  warn: () => undefined,
  log: () => undefined,
};

/** Best-effort — never throws. Platform-agnostic core, shared across bots. */
export class LlmSafetyCore {
  constructor(
    private readonly repository: LlmSafetyEventRepository,
    private readonly logger: LlmSafetyLogger = NOOP_LOGGER,
  ) {}

  recordGroundingWarning(input: RecordGroundingWarningInput): void {
    const payload: Record<string, unknown> = {
      toolNamesUsed: input.toolNamesUsed,
    };
    if (input.userTextPreview) {
      payload['userTextPreview'] = input.userTextPreview.slice(0, 200);
    }
    if (input.assistantTextPreview) {
      payload['assistantTextPreview'] = input.assistantTextPreview.slice(
        0,
        200,
      );
    }

    this.repository
      .insert({
        feature: 'FREE_FORM_CHAT',
        eventType: 'GROUNDING_WARNING',
        reason: input.reason,
        externalUserId: input.externalUserId,
        userId: input.userId,
        correlationId: input.correlationId,
        payload,
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `LlmSafetyCore.recordGroundingWarning failed: ${errorMessage(err)}`,
        );
      });
  }

  async countWarningsSince(since: Date): Promise<number> {
    return this.repository.countSince(since);
  }

  async deleteOlderThan(before: Date): Promise<number> {
    const deleted = await this.repository.deleteOlderThan(before);
    if (deleted > 0) {
      this.logger.log(`LLM_SAFETY_CLEANUP deleted=${deleted}`);
    }
    return deleted;
  }
}
