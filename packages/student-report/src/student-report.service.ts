import type {
  LlmExecutionPort,
  LlmProviderAdapter,
  LlmUsageRecorderPort,
} from '@wispace/llm-agent';
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
  formatReport,
  parseReportOutput,
} from './report-formatter';
import type { StudentCapacityInput, StudentCapacityReport } from './types';

const FEATURE = 'STUDENT_REPORT';

/** In-process retry for short Wispace outages; long outages still flow to each app's outbox. */
const CAPACITY_FETCH_MAX_ATTEMPTS = 3;
const CAPACITY_FETCH_BACKOFF_MS = 5_000;

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
    options?: { correlationId?: string },
  ): Promise<string> {
    const logger = this.ports.logger ?? NOOP_LOGGER;
    const correlationId = options?.correlationId ?? externalUserId;

    try {
      const input = await this.fetchCapacityData(externalUserId);
      const report = await this.generateAiReport(
        externalUserId,
        input,
        correlationId,
      );
      return formatReport(report);
    } catch (error) {
      if (error instanceof StudentReportNoScoreDataError) {
        logger.log(
          `No score data for report externalUserId=${externalUserId}; sending guidance message`,
        );
        return buildStudentReportNoScoreDataMessage();
      }

      if (isRetryableApiError(error)) {
        if (error.isRetryable()) {
          logger.warn(
            `Retryable API error for report externalUserId=${externalUserId} status=${error.statusCode} endpoint=${error.endpoint}`,
          );
          throw new StudentReportRetryableError(externalUserId, error);
        }

        logger.warn(
          `API unavailable for report externalUserId=${externalUserId} status=${error.statusCode} endpoint=${error.endpoint}`,
        );
        return buildStudentReportApiUnavailableMessage();
      }

      throw error;
    }
  }

  private async fetchCapacityData(
    externalUserId: string,
  ): Promise<StudentCapacityInput> {
    const logger = this.ports.logger ?? NOOP_LOGGER;

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.ports.capacityData.getCapacityData(externalUserId);
      } catch (error) {
        if (
          !isRetryableApiError(error) ||
          !error.isRetryable() ||
          attempt >= CAPACITY_FETCH_MAX_ATTEMPTS
        ) {
          throw error;
        }
        logger.warn(
          `Retrying capacity fetch for report externalUserId=${externalUserId} attempt=${attempt}/${CAPACITY_FETCH_MAX_ATTEMPTS} status=${error.statusCode} endpoint=${error.endpoint}`,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, CAPACITY_FETCH_BACKOFF_MS * attempt),
        );
      }
    }
  }

  private async generateAiReport(
    externalUserId: string,
    input: StudentCapacityInput,
    correlationId: string,
  ): Promise<StudentCapacityReport> {
    const logger = this.ports.logger ?? NOOP_LOGGER;
    const adapter = this.config.adapter;

    if (!adapter.isConfigured()) {
      logger.warn('LLM provider missing, using fallback report content');
      return buildFallbackReport(input);
    }

    const model = adapter.getDefaultModel();

    const response = await this.ports.llmExecution.run(
      () =>
        adapter.generateJson({
          feature: FEATURE,
          model,
          systemPrompt: this.config.systemPrompt,
          userContent: JSON.stringify(input),
          correlationId,
        }),
      { feature: FEATURE, correlationId },
    );

    this.ports.usageRecorder.recordFromCompletion({
      feature: FEATURE,
      externalUserId,
      model,
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
      return parseReportOutput(content, this.config.sanitizeText);
    } catch (error) {
      logger.warn(
        `Invalid student report LLM output externalUserId=${externalUserId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return buildFallbackReport(input);
    }
  }
}
