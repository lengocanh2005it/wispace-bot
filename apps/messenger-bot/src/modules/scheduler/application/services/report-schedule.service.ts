import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserGoalsApiService } from '@messenger/modules/student-report/infrastructure/wispace/user-goals-api.service';
import { rawDaysUntilExam } from '@messenger/shared/utils/exam-date.utils';
import { todayReportDate } from '@messenger/shared/utils/report-date.utils';
import { resolveAppTimezone } from '@messenger/shared/config/app-timezone';

@Injectable()
export class ReportScheduleService {
  constructor(
    private readonly configService: ConfigService,
    private readonly userGoalsApiService: UserGoalsApiService,
  ) {}

  async getDaysUntilExam(psid: string): Promise<number> {
    const goals = await this.userGoalsApiService.getUserGoals(psid);
    const examDateIso = this.userGoalsApiService.parseExamDate(goals.examDate);
    return this.calculateDaysUntilExam(examDateIso);
  }

  async shouldSendReportToday(psid: string): Promise<{
    shouldSend: boolean;
    daysUntilExam: number;
    examDate: string;
    minDays: number;
    maxDays: number;
  }> {
    const goals = await this.userGoalsApiService.getUserGoals(psid);
    const examDate = this.userGoalsApiService.parseExamDate(goals.examDate);
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
    return resolveAppTimezone(this.configService);
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
