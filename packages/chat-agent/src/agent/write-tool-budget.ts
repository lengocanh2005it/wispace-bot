/**
 * Per-user write-tool budget (#626) — the set of mutating agent tools that
 * carry a per-day + per-message cap, and the narrow port the executor calls.
 */

export const WRITE_TOOL_NAMES = [
  'reschedule_study_session',
  'precreate_next_exercise',
] as const;

export type WriteToolName = (typeof WRITE_TOOL_NAMES)[number];

export function isWriteToolName(name: string): name is WriteToolName {
  return (WRITE_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Non-`read_only` agent tools that are deliberately NOT budgeted by #626:
 * `register_exam_report_notifications` is a no-op on Discord/Zalo and a
 * mapping upsert (not a WISPACE mutation) on Messenger. A NEW mutating tool
 * must be added to WRITE_TOOL_NAMES or here consciously — the guard test
 * fails otherwise.
 */
export const BUDGET_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  'register_exam_report_notifications',
]);

export interface WriteToolBudgetPort {
  /** Read-only daily gate (reschedule stage). true = allowed. */
  checkDailyAllowed(
    externalUserId: string,
    userId: number,
    toolName: string,
  ): Promise<boolean>;
  /** Atomic check + consume of one daily unit (precreate). true = consumed. */
  consumeDaily(
    externalUserId: string,
    userId: number,
    toolName: string,
  ): Promise<boolean>;
  /** Refund one daily unit (precreate non-success). */
  refundDaily(userId: number, toolName: string): Promise<void>;
}
