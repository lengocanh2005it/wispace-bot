import { errorMessage } from '@wispace/bot-common/masking';
import type {
  RecordGroundingWarningInput,
  RecordInjectionEventInput,
  RecordHarmfulOutputBlockedInput,
  RecordClassifierVerdictInput,
  LlmSafetyEventRepositoryPort,
} from './types';
import { redactSafetyText } from './redact-safety-text';

export interface LlmSafetyLogger {
  warn(message: string): void;
  log(message: string): void;
}

const NOOP_LOGGER: LlmSafetyLogger = {
  warn: () => undefined,
  log: () => undefined,
};

function redactClassifierReason(reason: string, textPreview: string) {
  const normalizedText = textPreview.replace(/\s+/g, ' ').trim();
  const targets = new Set<string>();
  if (normalizedText.length >= 4) {
    targets.add(normalizedText);
    if (normalizedText.length > 64) {
      targets.add(normalizedText.slice(0, 32));
      targets.add(normalizedText.slice(-32));
    }
  }
  let redacted = reason;
  for (const target of targets) {
    const pattern = target
      .split(/\s+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s+');
    redacted = redacted.replace(new RegExp(pattern, 'gi'), '[REDACTED]');
  }
  return redactSafetyText(redacted, 100);
}

/** Best-effort — never throws. Platform-agnostic core, shared across bots. */
export class LlmSafetyCore {
  constructor(
    private readonly repository: LlmSafetyEventRepositoryPort,
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

  /**
   * #629 — a prompt-injection pattern was neutralized before it reached model
   * context. Only a redacted excerpt + hash of the offending text is persisted
   * (#122). Best-effort; never throws.
   */
  recordInjectionEvent(input: RecordInjectionEventInput): void {
    const payload: Record<string, unknown> = { source: input.source };
    if (input.toolName) {
      payload['toolName'] = input.toolName;
    }
    if (input.textPreview) {
      const redacted = redactSafetyText(input.textPreview);
      payload['textExcerpt'] = redacted.excerpt;
      payload['textHash'] = redacted.hash;
      payload['textLength'] = redacted.originalLength;
    }

    this.repository
      .insert({
        feature: 'FREE_FORM_CHAT',
        eventType: 'INJECTION_BLOCKED',
        reason: input.reason,
        externalUserId: input.externalUserId,
        userId: input.userId,
        correlationId: input.correlationId,
        payload,
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `LlmSafetyCore.recordInjectionEvent failed: ${errorMessage(err)}`,
        );
      });
  }

  /**
   * #1377 — the final-output guard replaced actionable harmful content.
   * Best-effort; only a redacted excerpt/hash/length reaches persistence.
   */
  recordHarmfulOutputBlocked(input: RecordHarmfulOutputBlockedInput): void {
    const redacted = redactSafetyText(input.assistantTextPreview);
    const payload: Record<string, unknown> = {
      category: input.reason,
      assistantTextExcerpt: redacted.excerpt,
      assistantTextHash: redacted.hash,
      assistantTextLength: redacted.originalLength,
    };

    this.repository
      .insert({
        feature: 'FREE_FORM_CHAT',
        eventType: 'HARMFUL_OUTPUT_BLOCKED',
        reason: input.reason,
        externalUserId: input.externalUserId,
        userId: input.userId,
        correlationId: input.correlationId,
        payload,
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `LlmSafetyCore.recordHarmfulOutputBlocked failed: ${errorMessage(err)}`,
        );
      });
  }

  /**
   * #649 — an LLM input-classifier verdict flagged a message as INJECTION or
   * DISCLOSURE_PROBE. Records the label, rollout mode and confidence; the
   * classifier input is persisted only as a redacted excerpt + hash (#122).
   * Best-effort; never throws. SAFE verdicts are not recorded here.
   */
  recordClassifierVerdict(input: RecordClassifierVerdictInput): void {
    const redacted = redactSafetyText(input.textPreview);
    const reason = redactSafetyText(input.reason);
    const reasonExcerpt = redactClassifierReason(
      input.reason,
      input.textPreview,
    );
    const payload: Record<string, unknown> = {
      label: input.label,
      mode: input.mode,
      confidence: input.confidence,
      textExcerpt: redacted.excerpt,
      textHash: redacted.hash,
      textLength: redacted.originalLength,
      reasonHash: reason.hash,
      reasonLength: reason.originalLength,
    };

    this.repository
      .insert({
        feature: 'FREE_FORM_CHAT',
        eventType: 'CLASSIFIER_FLAGGED',
        // `reason` column is varchar(100) — bound it here too, not only in
        // the classifier, so any future caller is safe.
        reason: reasonExcerpt.excerpt.slice(0, 100),
        externalUserId: input.externalUserId,
        userId: input.userId,
        correlationId: input.correlationId,
        payload,
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `LlmSafetyCore.recordClassifierVerdict failed: ${errorMessage(err)}`,
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
