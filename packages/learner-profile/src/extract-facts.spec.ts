import { extractFactsFromToolResult } from './extract-facts';

const NOW = new Date('2026-08-16T02:00:00.000Z');

describe('extractFactsFromToolResult', () => {
  it('extracts targetScore and examDate from get_user_goals', () => {
    const facts = extractFactsFromToolResult(
      'get_user_goals',
      { targetScore: 7, examDate: '2026-11-20' },
      NOW,
    );
    expect(facts).toEqual({
      targetScore: 7,
      targetScoreFetchedAt: NOW,
      examDate: '2026-11-20',
      examDateFetchedAt: NOW,
    });
  });

  it('returns null for tools outside the facts allowlist', () => {
    expect(
      extractFactsFromToolResult(
        'get_upcoming_study_sessions',
        { count: 1 },
        NOW,
      ),
    ).toBeNull();
    expect(
      extractFactsFromToolResult('precreate_next_exercise', {}, NOW),
    ).toBeNull();
  });

  it('drops malformed values instead of guessing', () => {
    expect(
      extractFactsFromToolResult(
        'get_user_goals',
        { targetScore: '7.0', examDate: '20/11/2026' },
        NOW,
      ),
    ).toBeNull();

    const partial = extractFactsFromToolResult(
      'get_user_goals',
      { targetScore: -1, examDate: '2026-11-20' },
      NOW,
    );
    expect(partial).toEqual({ examDate: '2026-11-20', examDateFetchedAt: NOW });
  });

  it('returns null for non-object results', () => {
    expect(extractFactsFromToolResult('get_user_goals', '7.0', NOW)).toBeNull();
    expect(extractFactsFromToolResult('get_user_goals', null, NOW)).toBeNull();
  });
});
