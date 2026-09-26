import { buildToolSummary } from './tool-summary';
import { fitToolObservation } from './tool-observation';

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

  it('keeps bounded calendar metadata in the deterministic summary', () => {
    const summary = buildToolSummary(
      ['get_upcoming_study_sessions'],
      [
        observation('get_upcoming_study_sessions', {
          count: 10,
          requestedLimit: 15,
          effectiveLimit: 10,
          capped: true,
          completeness: 'incomplete',
          sessions: [],
        }),
      ],
    );

    expect(summary).toBe(
      [
        '[Đã tra cứu: get_upcoming_study_sessions]',
        '[Kết quả]',
        'get_upcoming_study_sessions: count=10; requestedLimit=15; effectiveLimit=10; capped=true; completeness=incomplete',
      ].join('\n'),
    );
  });
  it('drops conflicting non-numeric summary fields instead of fabricating a minimum', () => {
    const summary = buildToolSummary(
      ['get_upcoming_study_sessions'],
      [
        observation('get_upcoming_study_sessions', {
          count: 1,
          requestedLimit: 15,
          effectiveLimit: 10,
          capped: true,
          completeness: 'incomplete',
          sessions: [
            {
              scheduledAtIso: '2026-09-25T10:00:00.000Z',
              scheduledTimeLabel: '123',
            },
          ],
        }),
        observation('get_upcoming_study_sessions', {
          count: 1,
          requestedLimit: 15,
          effectiveLimit: 10,
          capped: true,
          completeness: 'incomplete',
          sessions: [
            {
              scheduledAtIso: '2026-09-26T10:00:00.000Z',
              scheduledTimeLabel: '456',
            },
          ],
        }),
      ],
    );

    expect(summary).not.toContain('nearest=');
  });

  it('keeps constrained past and all scopes separate in history', () => {
    const past = fitToolObservation(
      JSON.stringify({
        ok: true,
        data: {
          timeRange: 'past',
          count: 10,
          capped: true,
          completeness: 'incomplete',
        },
      }),
      80,
    );
    const all = fitToolObservation(
      JSON.stringify({
        ok: true,
        data: {
          timeRange: 'all',
          count: 10,
          capped: true,
          completeness: 'incomplete',
        },
      }),
      80,
    );
    const summary = buildToolSummary(
      ['list_study_calendar_entries'],
      [
        {
          toolName: 'list_study_calendar_entries',
          content: past.content,
          succeeded: true,
          boundedDisclosure: {
            timeRange: 'past',
            limit: 10,
            pastDays: 365,
            requestedLimit: 15,
            requestedPastDays: 9999,
            count: 8,
            capped: true,
            completeness: 'incomplete',
          },
        },
        {
          toolName: 'list_study_calendar_entries',
          content: all.content,
          succeeded: true,
          boundedDisclosure: {
            timeRange: 'all',
            limit: 10,
            pastDays: 365,
            requestedLimit: 25,
            requestedPastDays: 9999,
            count: 10,
            capped: true,
            completeness: 'incomplete',
          },
        },
      ],
    );
    expect(
      summary?.match(
        /list_study_calendar_entries: timeRange=(?:past|all);[^\n]*capped=true/gu,
      ),
    ).toHaveLength(2);
    expect(summary).toContain('timeRange=past');
    expect(summary).toContain('timeRange=all');
    expect(summary).toContain('requestedLimit=15');
    expect(summary).toContain('requestedLimit=25');
    expect(summary).toContain('effectivePastDays=365');
  });

  it('keeps unknown bounded metadata in the summary', () => {
    const summary = buildToolSummary(
      ['list_study_calendar_entries'],
      [
        observation('list_study_calendar_entries', {
          timeRange: 'upcoming',
          count: 0,
          effectiveLimit: 10,
          capped: false,
          completeness: 'unknown',
          entries: [],
        }),
      ],
    );

    expect(summary).toContain('effectiveLimit=10');
    expect(summary).toContain('capped=false');
    expect(summary).toContain('completeness=unknown');
  });

  it('keeps requested bounds separate when compact observations omit them', () => {
    const content = fitToolObservation(
      JSON.stringify({
        ok: true,
        data: {
          timeRange: 'upcoming',
          count: 10,
          requestedLimit: 15,
          effectiveLimit: 10,
          capped: true,
          completeness: 'incomplete',
        },
      }),
      80,
    ).content;
    const summary = buildToolSummary(
      ['list_study_calendar_entries'],
      [15, 25].map((requestedLimit, index) => ({
        toolName: 'list_study_calendar_entries',
        content,
        succeeded: true,
        boundedDisclosure: {
          timeRange: 'upcoming' as const,
          limit: 10,
          requestedLimit,
          count: index === 0 ? 8 : 10,
          capped: true,
          completeness: 'incomplete' as const,
        },
      })),
    );

    expect(summary).toContain('requestedLimit=15');
    expect(summary).toContain('requestedLimit=25');
    expect(summary).toContain('count=8');
    expect(summary).toContain('count=10');
  });

  it('keeps different returned counts for repeated bounded scopes', () => {
    const summary = buildToolSummary(
      ['list_study_calendar_entries'],
      [
        observation('list_study_calendar_entries', {
          timeRange: 'past',
          count: 8,
          effectiveLimit: 10,
          effectivePastDays: 365,
          capped: true,
          completeness: 'incomplete',
          entries: [],
        }),
        observation('list_study_calendar_entries', {
          timeRange: 'past',
          count: 5,
          effectiveLimit: 10,
          effectivePastDays: 365,
          capped: true,
          completeness: 'incomplete',
          entries: [],
        }),
      ],
    );

    expect(summary).toContain('count=8');
    expect(summary).toContain('count=5');
  });

  it('does not erase a cap when a later same-tool result is uncapped', () => {
    const summary = buildToolSummary(
      ['get_upcoming_study_sessions'],
      [
        observation('get_upcoming_study_sessions', {
          count: 10,
          requestedLimit: 15,
          effectiveLimit: 10,
          capped: true,
          completeness: 'incomplete',
          sessions: [],
        }),
        observation('get_upcoming_study_sessions', {
          count: 2,
          effectiveLimit: 5,
          capped: false,
          completeness: 'unknown',
          sessions: [],
        }),
      ],
    );

    expect(summary).toContain('capped=true');
  });

  it('keeps different capped calendar scopes as separate lines', () => {
    const summary = buildToolSummary(
      ['list_study_calendar_entries'],
      [
        observation('list_study_calendar_entries', {
          timeRange: 'past',
          count: 8,
          requestedLimit: 10,
          effectiveLimit: 10,
          requestedPastDays: 9999,
          effectivePastDays: 365,
          capped: true,
          completeness: 'incomplete',
          entries: [],
        }),
        observation('list_study_calendar_entries', {
          timeRange: 'upcoming',
          count: 3,
          requestedLimit: 15,
          effectiveLimit: 10,
          capped: true,
          completeness: 'incomplete',
          entries: [],
        }),
      ],
    );

    expect(summary).toContain(
      'list_study_calendar_entries: timeRange=past; count=8; requestedLimit=10; effectiveLimit=10; requestedPastDays=9999; effectivePastDays=365; capped=true; completeness=incomplete',
    );
    expect(summary).toContain(
      'list_study_calendar_entries: timeRange=upcoming; count=3; requestedLimit=15; effectiveLimit=10; capped=true; completeness=incomplete',
    );
    expect(summary).not.toContain('requestedLimit=5');
  });

  it('keeps compact past and all calendar scopes separate', () => {
    const past = fitToolObservation(
      JSON.stringify({
        ok: true,
        data: {
          timeRange: 'past',
          count: 0,
          effectiveLimit: 10,
          effectivePastDays: 365,
          capped: true,
          completeness: 'incomplete',
          entries: [{ topic: 'x'.repeat(500) }],
        },
      }),
      160,
    );
    const all = fitToolObservation(
      JSON.stringify({
        ok: true,
        data: {
          timeRange: 'all',
          count: 0,
          effectiveLimit: 10,
          effectivePastDays: 365,
          capped: true,
          completeness: 'incomplete',
          entries: [{ topic: 'x'.repeat(500) }],
        },
      }),
      160,
    );
    const summary = buildToolSummary(
      ['list_study_calendar_entries'],
      [
        {
          toolName: 'list_study_calendar_entries',
          content: past.content,
          succeeded: true,
        },
        {
          toolName: 'list_study_calendar_entries',
          content: all.content,
          succeeded: true,
        },
      ],
    );
    expect(
      summary?.match(
        /list_study_calendar_entries: timeRange=(?:past|all); count=0/gu,
      ),
    ).toHaveLength(2);
  });

  it('keeps cap metadata when the calendar payload is truncated', () => {
    const summary = buildToolSummary(
      ['get_upcoming_study_sessions'],
      [
        {
          toolName: 'get_upcoming_study_sessions',
          succeeded: true,
          content: JSON.stringify({
            ok: true,
            _observation: 'truncated',
            data: {
              count: 10,
              requestedLimit: 15,
              effectiveLimit: 10,
              capped: true,
              completeness: 'incomplete',
              sessions: [],
            },
          }),
        },
      ],
    );

    expect(summary).toBe(
      [
        '[Đã tra cứu: get_upcoming_study_sessions]',
        '[Kết quả]',
        'get_upcoming_study_sessions: count=10; requestedLimit=15; effectiveLimit=10; capped=true; completeness=incomplete',
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
