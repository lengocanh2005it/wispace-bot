import { isAbortError } from '@wispace/bot-common/utils';
import type {
  PlatformAgentToolContext,
  PlatformToolExecutorPort,
} from './platform-agent.types';

export interface PlatformToolExecutorConformanceCase {
  identityExecutor: PlatformToolExecutorPort;
  identityContext: PlatformAgentToolContext;
  intentExecutor: PlatformToolExecutorPort;
  intentContext: PlatformAgentToolContext;
  budgetExecutor: PlatformToolExecutorPort;
  budgetContext: PlatformAgentToolContext;
  abortedExecutor: PlatformToolExecutorPort;
  abortedContext: PlatformAgentToolContext;
  abortedSignal: AbortSignal;
  policyDeniedCalls: readonly (readonly [string, string])[];
  intentDenied: (result: unknown) => boolean;
  forbiddenMetricValues: readonly string[];
}

export interface PlatformToolExecutorConformanceResult {
  identityBlocked: boolean;
  intentDenied: boolean;
  budgetDenied: boolean;
  abortPropagated: boolean;
  policyMetricsBounded: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Runs the policy seams that must remain identical for every production
 * executor. The caller supplies production instances so this cannot drift into
 * a test-only fake of the platform wiring.
 */
export async function exercisePlatformToolExecutorConformance(
  fixture: PlatformToolExecutorConformanceCase,
): Promise<PlatformToolExecutorConformanceResult> {
  const identityResult = await fixture.identityExecutor.execute(
    'get_user_goals',
    '{}',
    fixture.identityContext,
  );
  const intentResult = await fixture.intentExecutor.execute(
    'register_exam_report_notifications',
    '{}',
    fixture.intentContext,
  );
  const budgetResult = await fixture.budgetExecutor.execute(
    'precreate_next_exercise',
    '{}',
    fixture.budgetContext,
  );

  let abortPropagated = false;
  try {
    await fixture.abortedExecutor.execute(
      'get_user_goals',
      '{}',
      fixture.abortedContext,
      fixture.abortedSignal,
    );
  } catch (error) {
    abortPropagated = isAbortError(error);
  }

  const metricPayload = JSON.stringify(fixture.policyDeniedCalls);
  const policyMetricsBounded = fixture.policyDeniedCalls.every(
    ([toolName, reason]) =>
      toolName.length > 0 &&
      reason.length > 0 &&
      !fixture.forbiddenMetricValues.some((value) =>
        metricPayload.includes(value),
      ),
  );

  return {
    identityBlocked:
      isRecord(identityResult) && identityResult.available === false,
    intentDenied: fixture.intentDenied(intentResult),
    budgetDenied:
      isRecord(budgetResult) && budgetResult.status === 'budget_exceeded',
    abortPropagated,
    policyMetricsBounded,
  };
}
