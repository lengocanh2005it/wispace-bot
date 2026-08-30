import type {
  LlmExecutionPort,
  LlmProviderAdapter,
  LlmUsageRecorderPort,
} from '@wispace/llm-agent';
import { retryWithBackoff } from '@wispace/llm-agent';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import type { CapacityDataPort } from './ports';
import {
  StudentReportNoScoreDataError,
  StudentReportRetryableError,
  type RetryableApiError,
} from './errors';
import {
  buildStudentReportApiUnavailableMessage,
  buildStudentReportNoScoreDataMessage,
} from './messages';
import {
  buildFallbackReport,
  buildReport,
  formatReport,
  parseReportOutput,
} from './report-formatter';
import type { StudentCapacityInput, StudentCapacityReport } from './types';

const FEATURE = 'STUDENT_REPORT';

/** In-process retry for short Wispace outages; long outages still flow to each app's outbox. */
const CAPACITY_FETCH_MAX_ATTEMPTS = 3;
const CAPACITY_FETCH_BACKOFF_MS = 5_000;

/** Fixed 4-field JSON shape (600 chars max each) — cap bounds output tokens. */
const REPORT_MAX_OUTPUT_TOKENS = 500;

export interface StudentReportConfig {
  adapter: LlmProviderAdapter;
  systemPrompt: string;
  /** Strips platform-unsupported formatting (e.g. Markdown) from LLM output. */
  sanitizeText?: (raw: string) => string;
}

export interface StudentReportPorts {
  llmExecution: LlmExecutionPort;
  usageRecorder: LlmUsageRecorderPort;
  capacityData: CapacityDataPort;
  logger?: {
    log: (message: string) => void;
    warn: (message: string) => void;
  };
}

function isRetryableApiError(error: unknown): error is RetryableApiError {
  return (
    error instanceof Error &&
    typeof (error as RetryableApiError).statusCode === 'number' &&
    typeof (error as RetryableApiError).isRetryable === 'function'
  );
}

const NOOP_LOGGER = { log: () => undefined, warn: () => undefined };

/**
 * Framework-agnostic student report generation (capacity fetch → LLM call →
 * fallback → format), shared across all WISPACE bot platforms. Wispace API
 * access, LLM execution/usage recording, and prompt loading are ports —
 * implemented per app.
 */
export class StudentReportCore {
  constructor(
    private readonly config: StudentReportConfig,
    private readonly ports: StudentReportPorts,
  ) {}

  async generateReport(
    externalUserId: string,
    options?: { correlationId?: string; signal?: AbortSignal },
  ): Promise<string> {
    const correlationId = options?.correlationId ?? externalUserId;

    return this.runReportFlow(
      externalUserId,
      correlationId,
      (input) =>
        this.generateAiReport(
          externalUserId,
          input,
          correlationId,
          options?.signal,
        ).then(formatReport),
      options?.signal,
    );
  }

  /**
   * Deterministic report (no LLM call) with the same shape as the AI report —
   * used by chat tools to answer progress questions without extra LLM cost.
   * `signal` aborts the remaining work (Wispace capacity fetch + formatting)
   * when the agent already timed out — the tool must not keep burning API
   * calls after the caller gave up.
   */
  async generateReportStatic(
    externalUserId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.runReportFlow(
      externalUserId,
      externalUserId,
      (input) => Promise.resolve(formatReport(buildFallbackReport(input))),
      signal,
    );
  }

  private async runReportFlow(
    externalUserId: string,
    correlationId: string,
    generate: (input: StudentCapacityInput) => Promise<string>,
    signal?: AbortSignal,
  ): Promise<string> {
    const logger = this.ports.logger ?? NOOP_LOGGER;

    try {
      this.throwIfAborted(signal);
      const input = await this.fetchCapacityData(externalUserId, signal);
      this.throwIfAborted(signal);
      return await generate(input);
    } catch (error) {
      if (error instanceof StudentReportNoScoreDataError) {
        logger.log(
          `No score data for report externalUserId=${maskExternalId(
            externalUserId,
          )}; sending guidance message`,
        );
        return buildStudentReportNoScoreDataMessage();
      }

      if (isRetryableApiError(error)) {
        if (error.isRetryable()) {
          logger.warn(
            `Retryable API error for report externalUserId=${maskExternalId(
              externalUserId,
            )} status=${error.statusCode} endpoint=${error.endpoint}`,
          );
          throw new StudentReportRetryableError(externalUserId, error);
        }

        logger.warn(
          `API unavailable for report externalUserId=${maskExternalId(
            externalUserId,
          )} status=${error.statusCode} endpoint=${error.endpoint}`,
        );
        return buildStudentReportApiUnavailableMessage();
      }

      throw error;
    }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw signal.reason ?? new Error('Tool execution aborted (timeout)');
    }
  }

  private async fetchCapacityData(
    externalUserId: string,
    signal?: AbortSignal,
  ): Promise<StudentCapacityInput> {
    const logger = this.ports.logger ?? NOOP_LOGGER;

    return retryWithBackoff(
      () => this.ports.capacityData.getCapacityData(externalUserId, { signal }),
      {
        maxAttempts: CAPACITY_FETCH_MAX_ATTEMPTS,
        baseDelayMs: CAPACITY_FETCH_BACKOFF_MS,
        isRetryable: (error) =>
          isRetryableApiError(error) && error.isRetryable(),
        signal,
        onRetry: (attempt, delayMs, error) => {
          logger.warn(
            `Retrying capacity fetch for report externalUserId=${maskExternalId(
              externalUserId,
            )} attempt=${attempt}/${CAPACITY_FETCH_MAX_ATTEMPTS} status=${(error as RetryableApiError).statusCode} endpoint=${(error as RetryableApiError).endpoint}`,
          );
        },
      },
    );
  }

  private async generateAiReport(
    externalUserId: string,
    input: StudentCapacityInput,
    correlationId: string,
    signal?: AbortSignal,
  ): Promise<StudentCapacityReport> {
    const logger = this.ports.logger ?? NOOP_LOGGER;
    const adapter = this.config.adapter;

    if (!adapter.isConfigured()) {
      logger.warn('LLM provider missing, using fallback report content');
      return buildFallbackReport(input);
    }

    const model = adapter.getDefaultModel();

    const response = await this.ports.llmExecution.run(
      (execSignal) =>
        adapter.generateJson({
          feature: FEATURE,
          model,
          systemPrompt: this.config.systemPrompt,
          userContent: JSON.stringify(input),
          correlationId,
          maxOutputTokens: REPORT_MAX_OUTPUT_TOKENS,
          signal: execSignal,
        }),
      { feature: FEATURE, correlationId, signal },
    );

    this.ports.usageRecorder.recordFromCompletion({
      feature: FEATURE,
      externalUserId,
      provider: response.metadata.provider,
      model: response.metadata.model,
      response: {
        id: response.metadata.responseId ?? '',
        usage: response.metadata.usage
          ? {
              prompt_tokens: response.metadata.usage.promptTokens,
              completion_tokens: response.metadata.usage.completionTokens,
              total_tokens: response.metadata.usage.totalTokens,
            }
          : null,
      },
      correlationId,
      toolRound: 0,
    });

    const content = response.content;
    if (!content) {
      throw new Error('LLM provider returned empty content');
    }

    try {
      const prose = parseReportOutput(content, this.config.sanitizeText);
      // #124: factual fields come from source data; the LLM only supplies prose.
      return buildReport(prose, input);
    } catch (error) {
      logger.warn(
        `Invalid student report LLM output externalUserId=${maskExternalId(
          externalUserId,
        )}: ${errorMessage(error)}`,
      );
      return buildFallbackReport(input);
    }
  }
}
