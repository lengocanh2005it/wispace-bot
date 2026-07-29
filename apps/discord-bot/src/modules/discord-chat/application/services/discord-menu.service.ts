import { Injectable } from '@nestjs/common';
import { WispaceApiError } from '@wispace/wispace-client';
import { WispaceCalendarService } from '@discord/modules/wispace/application/services/wispace-calendar.service';
import { WispaceGoalsService } from '@discord/modules/wispace/application/services/wispace-goals.service';

const NOT_LINKED =
  'Bạn chưa liên kết tài khoản WISPACE với Discord. Vào WISPACE để lấy link "Kết nối Discord" rồi thử lại nhé.';

const TZ = 'Asia/Ho_Chi_Minh';

const DATE_FMT = new Intl.DateTimeFormat('vi-VN', {
  weekday: 'short',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: TZ,
});

@Injectable()
export class DiscordMenuService {
  constructor(
    private readonly calendarService: WispaceCalendarService,
    private readonly goalsService: WispaceGoalsService,
  ) {}

  async getUpcomingSessions(
    discordUserId: string,
    userId: number | undefined,
  ): Promise<string> {
    if (!userId) return NOT_LINKED;

    const sessions = await this.calendarService.getCalendarSessions(
      discordUserId,
      { timeRange: 'upcoming', limit: 5 },
    );

    if (sessions.length === 0) {
      return '📅 Không có buổi học nào sắp tới trong lịch của bạn.';
    }

    const lines = sessions.map(
      (s, i) => `${i + 1}. ${s.topic} — ${DATE_FMT.format(s.scheduledAt)}`,
    );
    return `📅 Lịch học sắp tới:\n\n${lines.join('\n')}`;
  }

  async getLearningProgress(
    discordUserId: string,
    userId: number | undefined,
  ): Promise<string> {
    if (!userId) return NOT_LINKED;

    let goals: Awaited<ReturnType<WispaceGoalsService['getUserGoals']>>;
    let taskScores: Awaited<
      ReturnType<WispaceGoalsService['getTaskScoreAverages']>
    >;
    try {
      [goals, taskScores] = await Promise.all([
        this.goalsService.getUserGoals(discordUserId),
        this.goalsService.getTaskScoreAverages(discordUserId),
      ]);
    } catch (error) {
      if (
        error instanceof WispaceApiError &&
        (error.statusCode === 401 || error.statusCode === 403)
      ) {
        return 'Tài khoản WISPACE của bạn chưa được kích hoạt hoặc chưa có dữ liệu học tập. Liên hệ WISPACE để được hỗ trợ nhé.';
      }
      throw error;
    }

    const lines: string[] = [
      `📊 Mục tiêu: Band ${goals.targetScore} | Ngày thi: ${goals.examDate}`,
      '',
    ];

    if (taskScores.length === 0) {
      lines.push('Chưa có dữ liệu điểm. Hãy nộp bài để xem tiến độ nhé!');
    } else {
      lines.push('Điểm trung bình:');
      for (const r of taskScores) {
        lines.push(
          `• ${r.task}: ${r.avgTotalScore.toFixed(1)} — đã làm ${r.totalTasks} bài`,
        );
      }
    }

    return lines.join('\n');
  }
}
