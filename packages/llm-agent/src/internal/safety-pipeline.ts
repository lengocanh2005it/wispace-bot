import type { BoundedToolDisclosure } from '../agent.tools';
import { checkLlmGrounding } from '../grounding/llm-grounding.utils';
import {
  checkFinalOutputSafety,
  checkPromptCanarySafety,
  isHarmfulOutputSafetyReason,
} from '../safety/final-output.utils';
import {
  buildCappedResultMessage,
  buildFinalOutputBlockedMessage,
  buildGroundingBlockedMessage,
  buildNonDisclosureReply,
} from '../messages';
import { sanitizeReplyText } from '../text.utils';

export type SafetyOutcome = 'allowed' | 'grounding_blocked' | 'final_blocked';

export interface SafetyEvaluationInput {
  text: string;
  userText: string;
  toolsCalled: ReadonlySet<string>;
  groundedTools?: ReadonlySet<string>;
  boundedToolDisclosures?: ReadonlyMap<string, BoundedToolDisclosure>;
  promptCanary?: string;
  includeBoundedDisclosures?: boolean;
}

export interface SafetyEvaluation {
  outcome: SafetyOutcome;
  text: string;
  reason?: string;
  toolSummary?: string;
  skipHistory?: boolean;
}

function evaluateFinalSafety(
  text: string,
  toolSummary: string | undefined,
): SafetyEvaluation {
  const sanitized = sanitizeReplyText(text);
  const finalSafety = checkFinalOutputSafety(sanitized);
  if (!finalSafety.unsafe)
    return { outcome: 'allowed', text: sanitized, toolSummary };
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

function hasBoundedDisclosure(
  text: string,
  disclosure: BoundedToolDisclosure,
  scopeKey: string,
): boolean {
  return text
    .split(/[.!?\n]+/u)
    .some((clause) =>
      hasBoundedDisclosureInClause(clause, disclosure, scopeKey),
    );
}

function hasBoundedDisclosureInClause(
  text: string,
  disclosure: BoundedToolDisclosure,
  scopeKey: string,
): boolean {
  const limitPattern = `(?:giới\\s+hạn|tối\\s+đa|limit|maximum\\s+of|up\\s+to)\\s*${disclosure.limit}(?:\\s*(?:mục|items?|records?|sessions?))?\\b`;
  const countPattern =
    disclosure.count === undefined
      ? undefined
      : `\\b${disclosure.count}\\s*(?:mục|items?|records?|buổi|sessions?)\\b`;
  const facts =
    countPattern === undefined
      ? new RegExp(limitPattern, 'iu').test(text)
      : new RegExp(
          `(?:${countPattern}[^.!?\\n]{0,120}${limitPattern}|${limitPattern}[^.!?\\n]{0,120}${countPattern})`,
          'iu',
        ).test(text);
  const pastDays =
    disclosure.pastDays === undefined ||
    new RegExp(`\\b${disclosure.pastDays}\\s*(?:ngày|days?)\\b`, 'iu').test(
      text,
    );
  const toolName = scopeKey.split(':', 1)[0];
  const hasPastScope = /(?:đã\s+qua|past|previous)/iu.test(text);
  const hasUpcomingScope = /(?:sắp\s+tới|upcoming|future)/iu.test(text);
  if (hasPastScope && hasUpcomingScope) return false;
  const hasGenericUpcomingScope =
    /giới\s+hạn\s+\d+\s+mục/iu.test(text) &&
    !/(?:sắp\s+tới|đã\s+qua|past|upcoming|future|all)/iu.test(text);
  const timeRange =
    toolName === 'get_upcoming_study_sessions'
      ? (/(?:buổi\s+học|lịch\s+học|sessions?|upcoming|future)/iu.test(text) &&
          !hasPastScope) ||
        hasGenericUpcomingScope
      : disclosure.timeRange === 'past'
        ? /(?:lịch\s+học\s+đã\s+qua|past|previous)/iu.test(text)
        : disclosure.timeRange === 'upcoming'
          ? /(?:lịch\s+học\s+sắp\s+tới|upcoming|future)/iu.test(text)
          : disclosure.timeRange === 'all'
            ? /(?:lịch\s+học\s+tổng\s+hợp|both\s+past\s+and\s+upcoming)/iu.test(
                text,
              )
            : !/(?:lịch(?:\s+học)?\s+(?:sắp\s+tới|đã\s+qua)|past|previous|upcoming|future|all)/iu.test(
                text,
              );
  const completeness =
    disclosure.capped || disclosure.completeness === 'incomplete'
      ? /(?:không\s+phải\s+(?:toàn\s+bộ|tất\s*cả)|(?:chưa|không)\s+thể\s+xác\s+nhận|not\s+(?:the\s+)?full|not\s+all|cannot\s+(?:confirm|say)|can't\s+(?:confirm|say)|(?:are|is|were|was)\s+not\s+(?:included|returned|shown|available)|(?:aren't|isn't|weren't|wasn't)\s+(?:included|returned|shown|available))/iu.test(
          text,
        )
      : /(?:(?:chưa|không)\s+thể\s+xác\s+nhận|không\s+phải\s+tất\s*cả|cannot\s+(?:confirm|say)|can't\s+(?:confirm|say)|not\s+(?:the\s+)?full|not\s+all)/iu.test(
          text,
        );
  return facts && pastDays && timeRange && completeness;
}

function appendBoundedDisclosures(
  text: string,
  disclosures: ReadonlyMap<string, BoundedToolDisclosure> | undefined,
): string {
  if (!disclosures || disclosures.size === 0) return text;
  const notes: string[] = [];
  let textWithNotes = text;
  for (const [scopeKey, disclosure] of [...disclosures.entries()].sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  )) {
    if (hasBoundedDisclosure(textWithNotes, disclosure, scopeKey)) continue;
    const toolName = scopeKey.split(':', 1)[0];
    const calendarLabel =
      toolName === 'get_upcoming_study_sessions'
        ? 'buổi học sắp tới'
        : toolName === 'list_study_calendar_entries'
          ? disclosure.timeRange === 'past'
            ? 'lịch học đã qua'
            : disclosure.timeRange === 'upcoming'
              ? 'lịch học sắp tới'
              : 'lịch học tổng hợp'
          : undefined;
    const note = buildCappedResultMessage(disclosure, calendarLabel);
    if (textWithNotes.includes(note)) continue;
    notes.push(note);
    textWithNotes = `${textWithNotes.trim()} ${note}`.trim();
  }
  return notes.length === 0 ? text : `${text.trim()} ${notes.join(' ')}`.trim();
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
      input.boundedToolDisclosures,
    );
    if (grounding.suspicious) {
      if (
        grounding.reason === 'capped_result_claim' &&
        grounding.replacementText
      ) {
        const remainingGrounding = checkLlmGrounding(
          grounding.replacementText,
          input.groundedTools ?? input.toolsCalled,
          input.userText,
        );
        if (!remainingGrounding.suspicious) {
          const finalSafety = evaluateFinalSafety(
            appendBoundedDisclosures(
              grounding.replacementText,
              input.boundedToolDisclosures,
            ),
            toolSummary,
          );
          return finalSafety.outcome === 'final_blocked'
            ? finalSafety
            : {
                ...finalSafety,
                outcome: 'grounding_blocked',
                reason: 'capped_result_claim',
              };
        }
      }
      return {
        outcome: 'grounding_blocked',
        text: buildGroundingBlockedMessage(),
        reason: grounding.reason ?? 'unknown',
        toolSummary,
      };
    }

    return evaluateFinalSafety(
      input.includeBoundedDisclosures !== false
        ? appendBoundedDisclosures(input.text, input.boundedToolDisclosures)
        : input.text,
      toolSummary,
    );
  }
}
