import {
  CLASSIFIER_SYSTEM_PROMPT,
  redactSecrets,
  type ClassifierLabel,
  type ClassifyFailureReason,
  type ClassifyResult,
  type ContentClassifierPort,
  type LlmProviderAdapter,
} from '@wispace/llm-agent';

const LABELS: readonly ClassifierLabel[] = [
  'SAFE',
  'INJECTION',
  'DISCLOSURE_PROBE',
];
const MAX_INPUT_CHARS = 512;
const MAX_REASON_CHARS = 100;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_OPEN_MS = 30_000;

export interface LlmContentClassifierDeps {
  adapter: LlmProviderAdapter;
  model: string;
  timeoutMs: number;
  logger?: { warn(message: string): void };
}

/**
 * #649 — second-tier input classifier. Calls the provider's single-shot
 * JSON endpoint on its own path: own `AbortSignal.timeout` deadline (which
 * aborts the in-flight request, not just the wrapper promise), no retry, no
 * shared concurrency budget, and a local circuit breaker. Never throws —
 * every failure returns `{ ok: false, reason }` and the caller fails open.
 *
 * Circuit breaker: `CIRCUIT_FAILURE_THRESHOLD` consecutive failures open it
 * for `CIRCUIT_OPEN_MS`; the first call afterwards is a single half-open
 * probe (concurrent calls are refused while it is in flight), and its result
 * either closes the circuit or re-opens it immediately.
 */
export class LlmContentClassifier implements ContentClassifierPort {
  private consecutiveFailures = 0;
  private openUntil = 0;
  private halfOpenInFlight = false;

  constructor(private readonly deps: LlmContentClassifierDeps) {}

  async classify(
    userText: string,
    correlationId?: string,
  ): Promise<ClassifyResult> {
    if (!this.admit()) {
      return { ok: false, reason: 'skipped_circuit_open' };
    }

    const cleaned = redactSecrets(userText).text.slice(0, MAX_INPUT_CHARS);
    const signal = AbortSignal.timeout(this.deps.timeoutMs);

    let content: string;
    try {
      const res = await this.deps.adapter.generateJson({
        feature: 'FREE_FORM_CHAT',
        model: this.deps.model,
        systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
        userContent: cleaned,
        maxOutputTokens: 120,
        correlationId,
        signal,
      });
      content = res.content;
    } catch {
      return this.settle(signal.aborted ? 'timeout' : 'error');
    }

    const verdict = this.parse(content);
    if (!verdict) {
      return this.settle('parse_failed');
    }

    this.consecutiveFailures = 0;
    this.openUntil = 0;
    this.halfOpenInFlight = false;
    return { ok: true, verdict };
  }

  /** Circuit gate. Returns false while open (or a probe is already in flight). */
  private admit(): boolean {
    if (this.openUntil === 0) {
      return true;
    }
    if (Date.now() < this.openUntil || this.halfOpenInFlight) {
      return false;
    }
    // Cooldown elapsed — let exactly one probe through.
    this.halfOpenInFlight = true;
    return true;
  }

  private settle(reason: ClassifyFailureReason): ClassifyResult {
    if (this.halfOpenInFlight) {
      // The half-open probe failed — re-open immediately, no need to
      // re-accumulate `CIRCUIT_FAILURE_THRESHOLD` failures.
      this.halfOpenInFlight = false;
      this.openUntil = Date.now() + CIRCUIT_OPEN_MS;
      this.deps.logger?.warn(
        `LlmContentClassifier half-open probe failed (${reason}); circuit re-opened for ${CIRCUIT_OPEN_MS}ms`,
      );
      return { ok: false, reason };
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
      this.openUntil = Date.now() + CIRCUIT_OPEN_MS;
      this.consecutiveFailures = 0;
      this.deps.logger?.warn(
        `LlmContentClassifier circuit opened for ${CIRCUIT_OPEN_MS}ms`,
      );
    }
    return { ok: false, reason };
  }

  private parse(
    raw: string,
  ): { label: ClassifierLabel; confidence: number; reason: string } | null {
    const obj = this.tryJson(raw);
    if (!obj || typeof obj !== 'object') return null;
    const rec = obj as Record<string, unknown>;
    const label = rec['label'];
    if (typeof label !== 'string' || !LABELS.includes(label as ClassifierLabel))
      return null;
    const confRaw = rec['confidence'];
    if (typeof confRaw !== 'number' || !Number.isFinite(confRaw)) return null;
    const confidence = Math.min(1, Math.max(0, confRaw));
    const reason =
      typeof rec['reason'] === 'string'
        ? (rec['reason'] as string).slice(0, MAX_REASON_CHARS)
        : '';
    return { label: label as ClassifierLabel, confidence, reason };
  }

  private tryJson(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
  }
}
