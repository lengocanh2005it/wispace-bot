import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  Optional,
} from '@nestjs/common';
import {
  errorMessage,
  maskExternalId,
  maskExternalIdInText,
  sanitizeLogValue,
} from '@wispace/bot-common/masking';
import { FALLBACK_DISPLAY_NAME } from '@wispace/bot-common/messages';
import {
  LlmAllProvidersExhaustedError,
  LlmOverloadError,
  LlmProviderCircuitOpenError,
  type LlmDegradedAction,
  type LlmDegradedFailureClass,
  type LlmDegradedModeEvent,
  type LlmProviderAdapter,
} from '@wispace/llm-agent';
import { isAbortError } from '@wispace/bot-common/utils';
import { BotMetricsService } from '@wispace/bot-metrics';
import { loadSystemPrompt } from '@messenger/shared/prompts/load-system-prompt';
import { DEFAULT_TOPIC } from '@messenger/shared/config/poc.constants';
import {
  parseReminderOutput,
  buildFallbackReminder,
  buildReminderOutput,
  formatReminder,
} from '../../domain/utils/reminder-formatter';
import { sanitizeUntrustedTextForLlm } from '@wispace/llm-agent';
import {
  REMINDER_STUDENT_DATA_PORT,
  type ReminderStudentDataPort,
} from '../../domain/ports/reminder-student-data.port';
import {
  NormalizedStudySession,
  StudyReminderLlmInput,
  StudyReminderLlmOutput,
} from '../../domain/entities/study-schedule.types';
import { LlmExecutionService } from '@messenger/modules/llm-execution/application/services/llm-execution.service';
import { LlmUsageRecorderService } from '@messenger/modules/llm-usage/application/services/llm-usage-recorder.service';
import { UserDisplayNameService } from '@messenger/modules/display-name/application/user-display-name.service';
import { StudyReminderScheduleService } from '@wispace/study-reminder-shared';
import { StudySessionSourceService } from './study-session-source.service';

/** Fixed 6-field JSON shape (chars capped in reminder-formatter) — bounds output tokens. */
const REMINDER_MAX_OUTPUT_TOKENS = 500;

@Injectable()
export class StudyReminderService {
  private readonly logger = new Logger(StudyReminderService.name);

  constructor(
    private readonly studySessionSourceService: StudySessionSourceService,
    private readonly studyReminderScheduleService: StudyReminderScheduleService,
    @Inject(REMINDER_STUDENT_DATA_PORT)
    private readonly studentData: ReminderStudentDataPort,
    private readonly userDisplayNameService: UserDisplayNameService,
    private readonly llmUsageRecorder: LlmUsageRecorderService,
    private readonly llmExecution: LlmExecutionService,
    @Inject('LLM_PROVIDER_ADAPTER')
    private readonly adapter: LlmProviderAdapter,
    @Optional()
    private readonly metrics?: BotMetricsService,
  ) {}

  async generateReminderForSession(
    psid: string,
    session: NormalizedStudySession,
    options?: { userId?: number; displayName?: string; jobId?: number },
  ): Promise<string> {
    const bundle = await this.generateReminderBundleForSession(
      psid,
      session,
      options,
    );
    return bundle.text;
  }

  async generateReminderBundleForSession(
    psid: string,
    session: NormalizedStudySession,
    options?: { userId?: number; displayName?: string; jobId?: number },
  ): Promise<{ text: string; output: StudyReminderLlmOutput }> {
    const displayName =
      options?.displayName?.trim() ||
      (await this.userDisplayNameService.resolveDisplayName({
        psid,
        userId: options?.userId,
      }));
    const safeDisplayName = this.sanitizeDisplayName(displayName, psid);
    const input = await this.buildLlmInput(psid, session, safeDisplayName);
    const output = await this.generateAiReminder(input, {
      psid,
      userId: options?.userId,
      jobId: options?.jobId,
    });
    return {
      text: formatReminder(output),
      output,
    };
  }

  async preloadDisplayNames(userIds: number[]): Promise<void> {
    await this.userDisplayNameService.preloadDisplayNames(userIds);
  }

  async getNextUpcomingSession(
    psid: string,
    userId?: number,
  ): Promise<NormalizedStudySession | null> {
    const sessions = await this.studySessionSourceService.getUpcomingSessions({
      psid,
      userId,
    });
    return sessions[0] ?? null;
  }

  private async buildLlmInput(
    psid: string,
    session: NormalizedStudySession,
    displayName: string,
  ): Promise<StudyReminderLlmInput> {
    const minutesUntil =
      this.studyReminderScheduleService.getMinutesUntilSession(
        session.scheduledAt,
      );
    const scheduledTimeLabel =
      this.studyReminderScheduleService.formatScheduledTimeLabel(
        session.scheduledAt,
      );
    const topic = this.sanitizeSessionTopic(session.topic, psid);

    const input: StudyReminderLlmInput = {
      displayName,
      scheduledAtIso: session.scheduledAt.toISOString(),
      scheduledTimeLabel,
      topic,
      minutesUntil: Math.round(minutesUntil),
    };

    try {
      const goals = await this.studentData.getUserGoals(psid);
      input.targetScore = goals.targetScore;
    } catch (error) {
      this.recordDegraded(
        psid,
        'upstream_unavailable',
        'continue_with_partial_data',
        psid,
      );
      this.logger.warn(
        `Could not load user goals for study reminder (psid=${maskExternalId(
          psid,
        )}): ${errorMessage(error)}`,
      );
    }

    try {
      const capacity = await this.studentData.getCapacityData(psid);
      input.task1Band = capacity.task1_band ?? undefined;
      input.task2Band = capacity.task2_band ?? undefined;
      if (input.targetScore == null) {
        input.targetScore = capacity.target_band ?? undefined;
      }
    } catch (error) {
      this.recordDegraded(
        psid,
        'upstream_unavailable',
        'continue_with_partial_data',
        psid,
      );
      this.logger.warn(
        `Could not load capacity data for study reminder (psid=${maskExternalId(
          psid,
        )}): ${errorMessage(error)}`,
      );
    }

    return input;
  }

  private async generateAiReminder(
    input: StudyReminderLlmInput,
    context: { psid: string; userId?: number; jobId?: number },
  ): Promise<StudyReminderLlmOutput> {
    if (!this.adapter.isConfigured()) {
      this.recordDegraded(
        context.psid,
        'provider_unconfigured',
        'reminder_fallback',
        context.jobId !== undefined ? String(context.jobId) : context.psid,
      );
      return buildFallbackReminder(input);
    }

    const model = this.adapter.getDefaultModel();
    const correlationId =
      context.jobId !== undefined ? String(context.jobId) : context.psid;

    let response;
    try {
      response = await this.llmExecution.run(
        (execSignal) =>
          this.adapter.generateJson({
            feature: 'STUDY_REMINDER',
            model,
            systemPrompt: loadSystemPrompt('studyReminder'),
            userContent: JSON.stringify(input),
            correlationId,
            maxOutputTokens: REMINDER_MAX_OUTPUT_TOKENS,
            signal: execSignal,
          }),
        {
          feature: 'STUDY_REMINDER',
          correlationId,
        },
      );
    } catch (error) {
      this.recordDegraded(
        context.psid,
        this.classifyLlmFailure(error),
        'durable_retry',
        correlationId,
      );
      throw error;
    }

    this.llmUsageRecorder.recordFromCompletion({
      feature: 'STUDY_REMINDER',
      psid: context.psid,
      userId: context.userId,
      provider: response.metadata.provider,
      model: response.metadata.model,
      response: {
        id: response.metadata.responseId ?? '',
        // #553 — pass usage through unmodified so cached tokens reach the
        // usage events (cache-savings measurement starts at this deploy;
        // older rows read cached_tokens 0).
        usage: response.metadata.usage,
      },
      correlationId,
    });

    const content = response.content;
    if (!content) {
      this.recordDegraded(
        context.psid,
        'invalid_output',
        'reminder_fallback',
        correlationId,
      );
      throw new InternalServerErrorException(
        'LLM provider returned empty content',
      );
    }

    try {
      const { prose, modelScheduledTime } = parseReminderOutput(content);
      if (
        modelScheduledTime &&
        modelScheduledTime !== input.scheduledTimeLabel
      ) {
        this.logger.warn(
          `Study reminder time mismatch psid=${maskExternalId(
            context.psid,
          )} model="${modelScheduledTime}" server="${input.scheduledTimeLabel}" — server label rendered`,
        );
      }
      // #123: the reminder time always comes from trusted server data; the
      // model's `scheduledTime` (if any) is never rendered.
      return buildReminderOutput(prose, input.scheduledTimeLabel);
    } catch (error) {
      this.recordDegraded(
        context.psid,
        'invalid_output',
        'reminder_fallback',
        correlationId,
      );
      this.logger.warn(
        `Invalid study reminder LLM output psid=${maskExternalId(
          context.psid,
        )}: ${errorMessage(error)}`,
      );
      return buildFallbackReminder(input);
    }
  }

  private classifyLlmFailure(error: unknown): LlmDegradedFailureClass {
    if (error instanceof LlmAllProvidersExhaustedError) {
      return 'provider_exhausted';
    }
    if (error instanceof LlmProviderCircuitOpenError) {
      return 'provider_circuit_open';
    }
    if (error instanceof LlmOverloadError) {
      return 'execution_overload';
    }
    if (isAbortError(error)) return 'timeout';
    return 'unknown';
  }

  private recordDegraded(
    psid: string,
    failureClass: LlmDegradedFailureClass,
    action: LlmDegradedAction,
    correlationId: string,
  ): void {
    const event: LlmDegradedModeEvent = {
      platform: 'messenger',
      feature: 'STUDY_REMINDER',
      failureClass,
      action,
      correlationId,
    };
    try {
      this.metrics?.incLlmDegradedMode(event);
    } catch {
      // Telemetry must never change reminder delivery or durable retry behavior.
    }
    this.logger.warn(
      `Study reminder degraded platform=messenger feature=STUDY_REMINDER failure_class=${failureClass} action=${action} correlation=${maskExternalIdInText(
        sanitizeLogValue(correlationId, 120),
        psid,
      )} psid=${maskExternalId(psid)}`,
    );
  }

  private sanitizeDisplayName(displayName: string, psid: string): string {
    const sanitized = sanitizeUntrustedTextForLlm(displayName, {
      maxChars: 80,
      unsafePlaceholder: FALLBACK_DISPLAY_NAME,
    });
    if (sanitized.wasSanitized) {
      this.logger.warn(
        `Display name sanitized for study reminder psid=${maskExternalId(
          psid,
        )} reason=${sanitized.reason ?? 'format'}`,
      );
    }

    return sanitized.text || FALLBACK_DISPLAY_NAME;
  }

  private sanitizeSessionTopic(topic: string, psid: string): string {
    const sanitized = sanitizeUntrustedTextForLlm(topic || DEFAULT_TOPIC, {
      maxChars: 160,
      unsafePlaceholder: DEFAULT_TOPIC,
    });
    if (sanitized.wasSanitized) {
      this.logger.warn(
        `Session topic sanitized for study reminder psid=${maskExternalId(
          psid,
        )} reason=${sanitized.reason ?? 'format'}`,
      );
    }

    return sanitized.text || DEFAULT_TOPIC;
  }
}
