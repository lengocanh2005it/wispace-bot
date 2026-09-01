import {
  CLASSIFIER_SYSTEM_PROMPT,
  redactSecrets,
  type ClassifierLabel,
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
const MAX_REASON_CHARS = 200;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_OPEN_MS = 30_000;

class TimeoutError extends Error {}

type FailReason = 'timeout' | 'error' | 'parse_failed' | 'circuit_open';

export interface LlmContentClassifierDeps {
  adapter: LlmProviderAdapter;
  model: string;
  timeoutMs: number;
  logger?: { warn(message: string): void };
  onOutcome?: (outcome: FailReason) => void;
}

/**
 * #649 — second-tier input classifier. Calls the provider's single-shot
 * JSON endpoint on its own path (own deadline, no retry, local circuit
 * breaker). Never throws: every failure returns `{ ok: false, reason }` and
 * the caller fails open.
 */
export class LlmContentClassifier implements ContentClassifierPort {
  private consecutiveFailures = 0;
  private openUntil = 0;

  constructor(private readonly deps: LlmContentClassifierDeps) {}

  async classify(
    userText: string,
    correlationId?: string,
  ): Promise<ClassifyResult> {
    if (this.openUntil > Date.now()) {
      this.deps.onOutcome?.('circuit_open');
      return { ok: false, reason: 'circuit_open' };
    }

    const cleaned = redactSecrets(userText).text.slice(0, MAX_INPUT_CHARS);

    let content: string;
    try {
      const res = await this.withTimeout(
        this.deps.adapter.generateJson({
          feature: 'FREE_FORM_CHAT',
          model: this.deps.model,
          systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
          userContent: cleaned,
          maxOutputTokens: 120,
          correlationId,
        }),
      );
      content = res.content;
    } catch (err) {
      const reason: FailReason =
        err instanceof TimeoutError ? 'timeout' : 'error';
      return this.fail(reason);
    }

    const verdict = this.parse(content);
    if (!verdict) {
      return this.fail('parse_failed');
    }

    this.consecutiveFailures = 0;
    this.openUntil = 0;
    return { ok: true, verdict };
  }

  private fail(reason: FailReason): ClassifyResult {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
      this.openUntil = Date.now() + CIRCUIT_OPEN_MS;
      this.consecutiveFailures = 0;
      this.deps.logger?.warn(
        `LlmContentClassifier circuit opened for ${CIRCUIT_OPEN_MS}ms`,
      );
    }
    this.deps.onOutcome?.(reason);
    return { ok: false, reason };
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new TimeoutError('classifier call timed out')),
        this.deps.timeoutMs,
      );
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
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
