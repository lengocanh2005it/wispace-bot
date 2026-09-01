/**
 * #649 — second-tier input classifier behind the regex guardrails. Runs on
 * a single fresh user message (no history), returns a structured verdict.
 * The implementation lives in `@wispace/chat-agent`; this package only
 * defines the contract (framework-agnostic).
 */

export type ClassifierLabel = 'SAFE' | 'INJECTION' | 'DISCLOSURE_PROBE';

export interface ClassifierVerdict {
  label: ClassifierLabel;
  /** Model-reported confidence, clamped to 0..1 by the implementation. */
  confidence: number;
  /** Short lowercase phrase, never an echo of the user's text. */
  reason: string;
}

/**
 * Why the classifier produced no usable verdict. `skipped_circuit_open` means
 * the local circuit breaker was open and the call was not attempted; the
 * others mean the call ran and failed.
 */
export type ClassifyFailureReason =
  | 'timeout'
  | 'error'
  | 'parse_failed'
  | 'skipped_circuit_open';

/**
 * Discriminated result. `ok: false` means the classifier produced nothing
 * usable — the caller MUST fail open (proceed as if the tier were absent).
 */
export type ClassifyResult =
  | { ok: true; verdict: ClassifierVerdict }
  | { ok: false; reason: ClassifyFailureReason };

export interface ContentClassifierPort {
  /**
   * Classify one user message. Never throws — every failure path returns
   * `{ ok: false, reason }`. `userText` is the raw learner message; the
   * implementation applies secret redaction + truncation itself.
   */
  classify(userText: string, correlationId?: string): Promise<ClassifyResult>;
}
