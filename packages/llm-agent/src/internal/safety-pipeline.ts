import { checkLlmGrounding } from '../utils/llm-grounding.utils';
import {
  checkFinalOutputSafety,
  checkPromptCanarySafety,
  isHarmfulOutputSafetyReason,
} from '../utils/final-output.utils';
import {
  buildFinalOutputBlockedMessage,
  buildGroundingBlockedMessage,
  buildNonDisclosureReply,
} from '../messages';
import { sanitizeReplyText } from '../utils/text.utils';

export type SafetyOutcome = 'allowed' | 'grounding_blocked' | 'final_blocked';

export interface SafetyEvaluationInput {
  text: string;
  userText: string;
  toolsCalled: ReadonlySet<string>;
  groundedTools?: ReadonlySet<string>;
  promptCanary?: string;
}

export interface SafetyEvaluation {
  outcome: SafetyOutcome;
  text: string;
  reason?: string;
  toolSummary?: string;
  skipHistory?: boolean;
}

/** Pure ordering of grounding, text sanitization, and final output guards. */
export class SafetyPipeline {
  evaluate(input: SafetyEvaluationInput): SafetyEvaluation {
    const toolSummary =
      input.toolsCalled.size > 0
        ? `[Đã tra cứu: ${[...input.toolsCalled].join('; ')}]`
        : undefined;
    if (input.promptCanary) {
      const canarySafety = checkPromptCanarySafety(
        input.text,
        input.promptCanary,
      );
      if (canarySafety.unsafe) {
        return {
          outcome: 'final_blocked',
          text: buildNonDisclosureReply(),
          reason: canarySafety.reason ?? 'unknown',
          toolSummary,
        };
      }
    }

    const grounding = checkLlmGrounding(
      input.text,
      input.groundedTools ?? input.toolsCalled,
      input.userText,
    );
    if (grounding.suspicious) {
      return {
        outcome: 'grounding_blocked',
        text: buildGroundingBlockedMessage(),
        reason: grounding.reason ?? 'unknown',
        toolSummary,
      };
    }

    const sanitized = sanitizeReplyText(input.text);
    const finalSafety = checkFinalOutputSafety(sanitized);
    if (finalSafety.unsafe) {
      return {
        outcome: 'final_blocked',
        text:
          isHarmfulOutputSafetyReason(finalSafety.reason) ||
          finalSafety.reason === 'credential_leak'
            ? buildFinalOutputBlockedMessage()
            : buildNonDisclosureReply(),
        reason: finalSafety.reason ?? 'unknown',
        toolSummary,
        ...(isHarmfulOutputSafetyReason(finalSafety.reason)
          ? { skipHistory: true }
          : {}),
      };
    }

    return { outcome: 'allowed', text: sanitized, toolSummary };
  }
}
