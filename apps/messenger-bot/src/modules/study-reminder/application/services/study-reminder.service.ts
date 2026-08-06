import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type LlmProviderAdapter } from '@wispace/llm-agent';
import { loadSystemPrompt } from '@messenger/shared/prompts/load-system-prompt';
import {
  DEFAULT_TOPIC,
  FALLBACK_DISPLAY_NAME,
} from '@messenger/shared/config/poc.constants';
import {
  parseJsonObject,
  readRequiredStringArrayField,
  readRequiredStringField,
} from '@messenger/shared/utils/llm-json-output.utils';
import { sanitizeUntrustedTextForLlm } from '@wispace/llm-agent';
import { TaskScoreAverageApiService } from '@messenger/modules/student-report/infrastructure/wispace/task-score-average-api.service';
import { UserGoalsApiService } from '@messenger/modules/student-report/infrastructure/wispace/user-goals-api.service';
import {
  NormalizedStudySession,
  StudyReminderLlmInput,
  StudyReminderLlmOutput,
} from '../../domain/entities/study-schedule.types';
import { LlmExecutionService } from '@messenger/modules/llm-execution/application/services/llm-execution.service';
import { LlmUsageRecorderService } from '@messenger/modules/llm-usage/application/services/llm-usage-recorder.service';
import { UserDisplayNameService } from './user-display-name.service';
import { StudyReminderScheduleService } from '@wispace/study-reminder-shared';
import { StudySessionSourceService } from './study-session-source.service';

@Injectable()
export class StudyReminderService {
  private readonly logger = new Logger(StudyReminderService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly studySessionSourceService: StudySessionSourceService,
    private readonly studyReminderScheduleService: StudyReminderScheduleService,
    private readonly userGoalsApiService: UserGoalsApiService,
    private readonly taskScoreAverageApi: TaskScoreAverageApiService,
    private readonly userDisplayNameService: UserDisplayNameService,
    private readonly llmUsageRecorder: LlmUsageRecorderService,
    private readonly llmExecution: LlmExecutionService,
    @Inject('LLM_PROVIDER_ADAPTER')
    private readonly adapter: LlmProviderAdapter,
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
      text: this.formatReminder(output),
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
      const goals = await this.userGoalsApiService.getUserGoals(psid);
      input.targetScore = goals.targetScore;
    } catch (error) {
      this.logger.warn(
        `Could not load user goals for study reminder (psid=${psid}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    try {
      const capacity = await this.taskScoreAverageApi.getCapacityData(psid);
      input.task1Band = capacity.task1_band;
      input.task2Band = capacity.task2_band;
      if (!input.targetScore) {
        input.targetScore = capacity.target_band;
      }
    } catch (error) {
      this.logger.warn(
        `Could not load capacity data for study reminder (psid=${psid}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return input;
  }

  private async generateAiReminder(
    input: StudyReminderLlmInput,
    context: { psid: string; userId?: number; jobId?: number },
  ): Promise<StudyReminderLlmOutput> {
    if (!this.adapter.isConfigured()) {
      return this.buildFallbackReminder(input);
    }

    const model = this.adapter.getDefaultModel();
    const correlationId =
      context.jobId !== undefined ? String(context.jobId) : context.psid;

    const response = await this.llmExecution.run(
      () =>
        this.adapter.generateJson({
          feature: 'STUDY_REMINDER',
          model,
          systemPrompt: loadSystemPrompt('studyReminder'),
          userContent: JSON.stringify(input),
          correlationId,
        }),
      {
        feature: 'STUDY_REMINDER',
        correlationId,
      },
    );

    this.llmUsageRecorder.recordFromCompletion({
      feature: 'STUDY_REMINDER',
      psid: context.psid,
      userId: context.userId,
      model,
      response: {
        id: response.metadata.responseId ?? '',
        usage: response.metadata.usage
          ? {
              prompt_tokens: response.metadata.usage.promptTokens,
              completion_tokens: response.metadata.usage.completionTokens,
              total_tokens: response.metadata.usage.totalTokens,
            }
          : undefined,
      },
      correlationId,
    });

    const content = response.content;
    if (!content) {
      throw new InternalServerErrorException(
        'LLM provider returned empty content',
      );
    }

    try {
      return this.parseReminderOutput(content);
    } catch (error) {
      this.logger.warn(
        `Invalid study reminder LLM output psid=${context.psid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return this.buildFallbackReminder(input);
    }
  }

  private parseReminderOutput(content: string): StudyReminderLlmOutput {
    const parsed = parseJsonObject(content);
    return {
      greeting: readRequiredStringField(parsed, 'greeting', { maxChars: 120 }),
      intro: readRequiredStringField(parsed, 'intro', { maxChars: 240 }),
      scheduledTime: readRequiredStringField(parsed, 'scheduledTime', {
        maxChars: 120,
      }),
      tasks: readRequiredStringArrayField(parsed, 'tasks', {
        minItems: 3,
        maxItems: 4,
        maxCharsPerItem: 180,
      }),
      motivation: readRequiredStringField(parsed, 'motivation', {
        maxChars: 500,
      }),
      signoff: readRequiredStringField(parsed, 'signoff', { maxChars: 120 }),
    };
  }

  private sanitizeDisplayName(displayName: string, psid: string): string {
    const sanitized = sanitizeUntrustedTextForLlm(displayName, {
      maxChars: 80,
      unsafePlaceholder: FALLBACK_DISPLAY_NAME,
    });
    if (sanitized.wasSanitized) {
      this.logger.warn(
        `Display name sanitized for study reminder psid=${psid} reason=${sanitized.reason ?? 'format'}`,
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
        `Session topic sanitized for study reminder psid=${psid} reason=${sanitized.reason ?? 'format'}`,
      );
    }

    return sanitized.text || DEFAULT_TOPIC;
  }

  private buildFallbackReminder(
    input: StudyReminderLlmInput,
  ): StudyReminderLlmOutput {
    const tasks = [
      'Ôn lại các bài essay gần đây và feedback',
      `Luyện viết theo chủ đề ${input.topic}`,
      'Tập trung vào điểm cần cải thiện',
    ];

    if (input.targetScore) {
      tasks.push(`Theo dõi tiến độ hướng band mục tiêu ${input.targetScore}`);
    }

    return {
      greeting:
        input.displayName.trim() === FALLBACK_DISPLAY_NAME
          ? 'Chào bạn nha,'
          : `Chào ${input.displayName},`,
      intro: 'mình nhắc bạn về buổi luyện IELTS Writing sắp tới nhé.',
      scheduledTime: input.scheduledTimeLabel,
      tasks,
      motivation:
        'Kiên trì luyện tập mỗi ngày sẽ giúp bạn tiến gần hơn tới mục tiêu IELTS. Chỉ cần một buổi ngắn cũng tạo khác biệt lớn!',
      signoff: 'Cố lên nhé! 💪',
    };
  }

  private formatReminder(output: StudyReminderLlmOutput): string {
    const taskLines = output.tasks.map((task) => `• ${task}`).join('\n');
    const opening = [output.greeting, output.intro]
      .map((part) => part.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ');

    return [
      opening,
      '',
      `📅 ${output.scheduledTime}`,
      '',
      'Gợi ý trước giờ học:',
      taskLines,
      '',
      output.motivation,
      '',
      output.signoff,
    ].join('\n');
  }
}
