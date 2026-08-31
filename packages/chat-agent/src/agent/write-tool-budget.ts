/**
 * Per-user write-tool budget (#626) — the set of mutating agent tools that
 * carry a per-day + per-message cap, the narrow port the executor calls, and
 * the shared enforcement gate used by BOTH the Discord/Zalo
 * `PlatformAgentToolsService` and Messenger's app-owned executor.
 */
import {
  buildWriteToolDailyBudgetMessage,
  buildWriteToolPerMessageBudgetMessage,
} from '@wispace/llm-agent';

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

/**
 * Minimal view of the per-turn tool context the budget gate reads and mutates.
 * `PlatformAgentToolContext` (chat-agent) and Messenger's context both satisfy
 * it structurally — declared here to keep this module free of a cycle with
 * `platform-agent.types.ts`.
 */
export interface WriteToolBudgetContext {
  externalUserId: string;
  /** WISPACE userId — always set for `linked_wispace_account` tools by the
   *  time the gate runs; the gate no-ops when absent (#416 fail-closes first). */
  userId?: number;
  /** In-memory per-turn count of write-tool executions, keyed by tool name. */
  writeToolCalls?: Map<string, number>;
  /** Tools whose daily unit was consumed this turn — refunded on non-success. */
  writeToolDailyConsumed?: Set<string>;
}

export type BudgetExceededResult = {
  status: 'budget_exceeded';
  messageHint: string;
};

export interface WriteToolBudgetGateDeps {
  budget: WriteToolBudgetPort;
  /** tool name → per-message cap. Absent tool → no per-message limit. */
  perMessageCaps?: Record<string, number>;
  /** Bounded denial metric; only ever called with reason `'per_message'` here
   *  — daily denials are emitted inside the budget engine. No ids. */
  deniedInc?: (toolName: string, reason: 'per_message') => void;
}

/**
 * Enforce the per-message + per-day budget for one mutating tool call (#626).
 * Returns a relayable `budget_exceeded` result to short-circuit `dispatch()`,
 * or `undefined` to proceed.
 *
 * - `reschedule_study_session`: read-only daily check only (the authoritative
 *   consume happens at confirm time in `@wispace/reschedule-confirm`).
 * - `precreate_next_exercise`: consumes one daily unit here and records it on
 *   `ctx.writeToolDailyConsumed`; call {@link refundConsumedWriteToolBudget}
 *   after dispatch when the result is not a fresh create.
 */
export async function runWriteToolBudgetGate(
  toolName: WriteToolName,
  ctx: WriteToolBudgetContext,
  deps: WriteToolBudgetGateDeps,
): Promise<BudgetExceededResult | undefined> {
  const userId = ctx.userId;
  if (!userId) return undefined;

  const perMessageCap = deps.perMessageCaps?.[toolName];
  if (perMessageCap !== undefined) {
    ctx.writeToolCalls ??= new Map();
    const soFar = ctx.writeToolCalls.get(toolName) ?? 0;
    if (soFar >= perMessageCap) {
      deps.deniedInc?.(toolName, 'per_message');
      return {
        status: 'budget_exceeded',
        messageHint: buildWriteToolPerMessageBudgetMessage(
          toolName,
          perMessageCap,
        ),
      };
    }
    ctx.writeToolCalls.set(toolName, soFar + 1);
  }

  if (toolName === 'reschedule_study_session') {
    const allowed = await deps.budget.checkDailyAllowed(
      ctx.externalUserId,
      userId,
      toolName,
    );
    return allowed
      ? undefined
      : {
          status: 'budget_exceeded',
          messageHint: buildWriteToolDailyBudgetMessage(toolName),
        };
  }

  const consumed = await deps.budget.consumeDaily(
    ctx.externalUserId,
    userId,
    toolName,
  );
  if (!consumed) {
    return {
      status: 'budget_exceeded',
      messageHint: buildWriteToolDailyBudgetMessage(toolName),
    };
  }
  ctx.writeToolDailyConsumed ??= new Set();
  ctx.writeToolDailyConsumed.add(toolName);
  return undefined;
}

/**
 * Refund the daily unit consumed by {@link runWriteToolBudgetGate} for
 * `precreate_next_exercise` when the tool result is not a fresh create (#626).
 * No-op for any other tool or when nothing was consumed.
 */
export async function refundConsumedWriteToolBudget(
  ctx: WriteToolBudgetContext,
  budget: WriteToolBudgetPort | undefined,
  result: unknown,
): Promise<void> {
  if (!ctx.writeToolDailyConsumed?.has('precreate_next_exercise')) return;
  const created =
    !!result &&
    typeof result === 'object' &&
    (result as { status?: unknown }).status === 'created';
  if (created) return;
  await budget?.refundDaily(ctx.userId!, 'precreate_next_exercise');
  ctx.writeToolDailyConsumed.delete('precreate_next_exercise');
}
