import type { LlmProviderMetadata } from '../provider/types';

/**
 * #649 — second-tier input classifier behind the regex guardrails. Runs on
 * a single fresh user message (no history), returns a structured verdict.
 * The implementation lives in `@wispace/chat-agent`; this package only
 * defines the contract (framework-agnostic).
 */

/**
 * #649 / #1054 — canonical label registry for the second-tier input classifier.
 * Single source of truth for runtime parsing, telemetry, prompt contract tests,
 * and evaluation harness.
 */
export const CLASSIFIER_LABELS = [
  'SAFE',
  'INJECTION',
  'DISCLOSURE_PROBE',
  'ABUSE',
  'CRISIS',
] as const;

export type ClassifierLabel = (typeof CLASSIFIER_LABELS)[number];

export const CLASSIFIER_FAILURE_REASONS = [
  'timeout',
  'error',
  'parse_failed',
  'aborted',
  'skipped_circuit_open',
  'queue_full',
  'wait_timeout',
  'global_saturated',
  'redis_unavailable',
  'execution_disabled',
] as const;

export type ClassifyFailureReason = (typeof CLASSIFIER_FAILURE_REASONS)[number];

export const CLASSIFIER_OUTCOME_LABELS = [
  ...CLASSIFIER_LABELS,
  ...CLASSIFIER_FAILURE_REASONS,
] as const;

export type ClassifierOutcomeLabel = (typeof CLASSIFIER_OUTCOME_LABELS)[number];

/** Non-SAFE classifier labels recorded as CLASSIFIER_FLAGGED events. */
export type FlaggedClassifierLabel = Exclude<ClassifierLabel, 'SAFE'>;

export interface ClassifierVerdict {
  label: ClassifierLabel;
  /** Model-reported confidence, clamped to 0..1 by the implementation. */
  confidence: number;
  /** Short lowercase phrase, never an echo of the user's text. */
  reason: string;
}

/**
 * #625 — returns true if classifier reason indicates a system-prompt extraction attempt.
 */
export function isExtractionReason(reason: string): boolean {
  return reason.toLowerCase().includes('extraction');
}

/**
 * Why the classifier produced no usable verdict. `skipped_circuit_open` means
 * the local circuit breaker was open and the call was not attempted; the
 * others mean the call ran and failed.
 */
/**
 * Discriminated result. `completion` is preserved whenever the provider
 * returned response metadata, including malformed JSON responses.
 */
export type ClassifyResult =
  | {
      ok: true;
      verdict: ClassifierVerdict;
      completion?: LlmProviderMetadata;
    }
  | {
      ok: false;
      reason: ClassifyFailureReason;
      completion?: LlmProviderMetadata;
    };

export interface ContentClassifierPort {
  /**
   * Classify one user message. Never throws — every failure path returns
   * `{ ok: false, reason }`. `userText` is the raw learner message; the
   * implementation applies secret redaction + bounded projection itself.
   */
  classify(
    userText: string,
    correlationId?: string,
    signal?: AbortSignal,
  ): Promise<ClassifyResult>;
}
