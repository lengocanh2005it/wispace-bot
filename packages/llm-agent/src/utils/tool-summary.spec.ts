import { buildToolSummary } from './tool-summary';

function observation(
  toolName: string,
  data: unknown,
  succeeded = true,
): { toolName: string; content: string; succeeded: boolean } {
  return {
    toolName,
    content: JSON.stringify(
      succeeded ? { ok: true, data } : { ok: false, error: 'failed' },
    ),
    succeeded,
  };
}

describe('buildToolSummary', () => {
  it('uses the latest successful result and deduplicates identifiers', () => {
    const summary = buildToolSummary(
      ['get_user_goals', 'list_study_calendar_entries'],
      [
        observation('get_user_goals', {
          targetScore: 6.5,
          examDate: '2026-09-01',
        }),
        observation('get_user_goals', {
          targetScore: 7,
          examDate: '2026-11-20',
        }),
        observation('list_study_calendar_entries', {
          entries: [
            {
              calendarId: 42,
              scheduledAtIso: '2026-09-20T12:00:00.000Z',
              scheduledTimeLabel: 'Ngày kia lúc 19:00',
            },
            {
              calendarId: 42,
              scheduledAtIso: '2026-09-18T12:00:00.000Z',
              scheduledTimeLabel: 'Ngày mai lúc 19:00',
            },
          ],
        }),
      ],
    );

    expect(summary).toBe(
      [
        '[Đã tra cứu: get_user_goals; list_study_calendar_entries]',
        '[Kết quả]',
        'get_user_goals: targetScore=7; examDate=2026-11-20',
        'list_study_calendar_entries: count=2; nearest=Ngày mai lúc 19:00',
        '[Identifiers]',
        'list_study_calendar_entries.calendarId=42',
      ].join('\n'),
    );
  });

  it('keeps an explicit empty calendar result and falls back to item count', () => {
    expect(
      buildToolSummary(
        ['get_upcoming_study_sessions', 'list_study_calendar_entries'],
        [
          observation('get_upcoming_study_sessions', {
            count: 0,
            sessions: [],
          }),
          observation('list_study_calendar_entries', { entries: [] }),
        ],
      ),
    ).toBe(
      [
        '[Đã tra cứu: get_upcoming_study_sessions; list_study_calendar_entries]',
        '[Kết quả]',
        'get_upcoming_study_sessions: count=0',
        'list_study_calendar_entries: count=0',
      ].join('\n'),
    );
  });

  it('does not use failed, truncated, or invalid identifier observations', () => {
    const summary = buildToolSummary(
      ['get_user_goals', 'precreate_next_exercise'],
      [
        {
          toolName: 'get_user_goals',
          succeeded: true,
          content: JSON.stringify({
            ok: true,
            data: {
              targetScore: 7,
              examDate: '[Content removed]',
            },
            _observation: 'truncated',
          }),
        },
        observation(
          'precreate_next_exercise',
          {
            status: 'created',
            exerciseUrl: 'http://not-https.example/exercise/1',
          },
          true,
        ),
        {
          toolName: 'get_user_goals',
          succeeded: true,
          content: JSON.stringify({
            ok: true,
            data: { targetScore: 8 },
            _observation: 'truncated',
          }),
        },
      ],
    );

    expect(summary).toBe(
      [
        '[Đã tra cứu: get_user_goals; precreate_next_exercise]',
        '[Kết quả]',
        'precreate_next_exercise: status=created',
      ].join('\n'),
    );
  });

  it('emits identifiers in canonical field order, independent of call order', () => {
    const summary = buildToolSummary(
      ['precreate_next_exercise', 'list_study_calendar_entries'],
      [
        observation('precreate_next_exercise', {
          status: 'created',
          exerciseUrl: 'https://wispace.example/exercises/123',
        }),
        observation('list_study_calendar_entries', {
          entries: [{ calendarId: 42 }],
        }),
      ],
    );

    expect(summary).toContain(
      [
        '[Identifiers]',
        'list_study_calendar_entries.calendarId=42',
        'precreate_next_exercise.exerciseUrl=https://wispace.example/exercises/123',
      ].join('\n'),
    );
  });

  it('does not render non-terminal precreate statuses as outcomes', () => {
    expect(
      buildToolSummary(
        ['precreate_next_exercise'],
        [observation('precreate_next_exercise', { status: 'unavailable' })],
      ),
    ).toBe('[Đã tra cứu: precreate_next_exercise]');
  });

  it('keeps the legacy names-only shape when no supported observation is reliable', () => {
    expect(
      buildToolSummary(
        ['get_learning_progress_report', 'reschedule_study_session'],
        [
          observation(
            'get_learning_progress_report',
            { report: 'full report' },
            false,
          ),
        ],
      ),
    ).toBe(
      '[Đã tra cứu: get_learning_progress_report; reschedule_study_session]',
    );
  });
});
