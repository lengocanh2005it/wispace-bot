import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { rawDaysUntilExam } from '../utils/exam-date.utils';
import { todayReportDate } from '../utils/report-date.utils';
import { GOALS_DATA_PORT } from '../ports/goals-data.port';
import type { GoalsDataPort } from '../ports/goals-data.port';

const DEFAULT_TIMEZONE = 'Asia/Ho_Chi_Minh';

/** Result of the days-before-exam window check used by the report crons. */
export interface ExamWindowResult {
  shouldSend: boolean;
  daysUntilExam: number;
  examDate: string;
  minDays: number;
  maxDays: number;
}

@Injectable()
export class ReportScheduleService {
  constructor(
    private readonly configService: ConfigService,
    @Inject(GOALS_DATA_PORT) private readonly goalsDataPort: GoalsDataPort,
  ) {}

  async getDaysUntilExam(externalUserId: string): Promise<number> {
    const goals = await this.goalsDataPort.getUserGoals(externalUserId);
    const examDateIso = this.goalsDataPort.parseExamDate(goals.examDate);
    return this.calculateDaysUntilExam(examDateIso);
  }

  /** Exam-window decision used by the 08:00 report crons. */
  async shouldSendReportToday(
    externalUserId: string,
  ): Promise<ExamWindowResult> {
    const goals = await this.goalsDataPort.getUserGoals(externalUserId);
    const examDate = this.goalsDataPort.parseExamDate(goals.examDate);
    const daysUntilExam = this.calculateDaysUntilExam(examDate);
    const minDays = this.getMinDaysBeforeExam();
    const maxDays = this.getMaxDaysBeforeExam();

    return {
      shouldSend: daysUntilExam >= minDays && daysUntilExam <= maxDays,
      daysUntilExam,
      examDate,
      minDays,
      maxDays,
    };
  }

  getExamReminderWindow(): { minDays: number; maxDays: number } {
    return {
      minDays: this.getMinDaysBeforeExam(),
      maxDays: this.getMaxDaysBeforeExam(),
    };
  }

  calculateDaysUntilExam(
    examDateIso: string,
    today: Date = new Date(),
  ): number {
    const currentDate = todayReportDate(this.getReportTimezone(), today);
    return rawDaysUntilExam(examDateIso, currentDate);
  }

  private getReportTimezone(): string {
    return (
      this.configService.get<string>('CHAT_USAGE_TIMEZONE')?.trim() ||
      DEFAULT_TIMEZONE
    );
  }

  private getMinDaysBeforeExam(): number {
    return Number(
      this.configService.get<string>('WISPACE_REPORT_DAYS_BEFORE_EXAM_MIN') ??
        2,
    );
  }

  private getMaxDaysBeforeExam(): number {
    return Number(
      this.configService.get<string>('WISPACE_REPORT_DAYS_BEFORE_EXAM_MAX') ??
        3,
    );
  }
}
