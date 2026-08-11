import { resolveExamWindowOrNull } from './exam-window.utils';
import type { ReportScheduleService } from '../services/report-schedule.service';

describe('resolveExamWindowOrNull', () => {
  const buildSchedule = (
    overrides: {
      shouldSend?: boolean;
      reject?: boolean;
    } = {},
  ) =>
    ({
      shouldSendReportToday: overrides.reject
        ? jest.fn().mockRejectedValue(new Error('Wispace down'))
        : jest.fn().mockResolvedValue({
            shouldSend: overrides.shouldSend ?? true,
            daysUntilExam: 3,
            examDate: '2026-08-14',
            minDays: 2,
            maxDays: 3,
          }),
    }) as unknown as ReportScheduleService;

  it('allows send inside the window and returns the exam date', async () => {
    const result = await resolveExamWindowOrNull(
      'user-1',
      buildSchedule({ shouldSend: true }),
      false,
    );
    expect(result).toEqual({ examDate: '2026-08-14', skip: false });
  });

  it('skips outside the window', async () => {
    const result = await resolveExamWindowOrNull(
      'user-1',
      buildSchedule({ shouldSend: false }),
      false,
    );
    expect(result).toEqual({ examDate: undefined, skip: true });
  });

  it('skips when the exam schedule cannot be resolved', async () => {
    const result = await resolveExamWindowOrNull(
      'user-1',
      buildSchedule({ reject: true }),
      false,
    );
    expect(result).toEqual({ examDate: undefined, skip: true });
  });

  it('forceSend bypasses the window but keeps the exam date', async () => {
    const result = await resolveExamWindowOrNull(
      'user-1',
      buildSchedule({ shouldSend: false }),
      true,
    );
    expect(result).toEqual({ examDate: '2026-08-14', skip: false });
  });

  it('forceSend with an unresolvable schedule still sends (no exam date for outbox)', async () => {
    const result = await resolveExamWindowOrNull(
      'user-1',
      buildSchedule({ reject: true }),
      true,
    );
    expect(result).toEqual({ examDate: undefined, skip: false });
  });
});
