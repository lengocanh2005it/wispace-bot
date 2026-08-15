import { errorMessage } from '@wispace/bot-common';
import type { LlmSafetyEventRepository } from './llm-safety.repository';
import type { RecordGroundingWarningInput } from './types';
import { redactSafetyText } from './redact-safety-text';

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
    // #122: only redacted excerpts + hashes are persisted — never raw
    // user/assistant text (PII, secrets, prompt content stay out of the DB).
    if (input.userTextPreview) {
      const redacted = redactSafetyText(input.userTextPreview);
      payload['userTextExcerpt'] = redacted.excerpt;
      payload['userTextHash'] = redacted.hash;
      payload['userTextLength'] = redacted.originalLength;
    }
    if (input.assistantTextPreview) {
      const redacted = redactSafetyText(input.assistantTextPreview);
      payload['assistantTextExcerpt'] = redacted.excerpt;
      payload['assistantTextHash'] = redacted.hash;
      payload['assistantTextLength'] = redacted.originalLength;
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
