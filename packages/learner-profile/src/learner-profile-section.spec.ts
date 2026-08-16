import { buildLearnerProfileSection } from './learner-profile-section';
import type { LearnerProfile } from './types';

const NOW = new Date('2026-08-16T02:00:00.000Z');
const TTL = 24 * 60 * 60 * 1000;

function profile(overrides: Partial<LearnerProfile> = {}): LearnerProfile {
  return {
    platform: 'messenger',
    externalUserId: 'eval-profile-0001',
    ...overrides,
  };
}

describe('buildLearnerProfileSection', () => {
  it('lists fresh facts with their fetch time', () => {
    const section = buildLearnerProfileSection(
      profile({
        targetScore: 7,
        targetScoreFetchedAt: new Date('2026-08-16T01:00:00.000Z'),
        examDate: '2026-11-20',
        examDateFetchedAt: new Date('2026-08-15T10:00:00.000Z'),
      }),
      NOW,
      TTL,
    );
    expect(section).toContain('Mục tiêu band: 7');
    expect(section).toContain('Ngày thi: 2026-11-20');
  });

  it('omits stale facts and returns undefined when nothing is fresh', () => {
    const stale = new Date('2026-08-01T00:00:00.000Z');
    expect(
      buildLearnerProfileSection(
        profile({
          targetScore: 7,
          targetScoreFetchedAt: stale,
          examDate: '2026-11-20',
          examDateFetchedAt: stale,
        }),
        NOW,
        TTL,
      ),
    ).toBeUndefined();
  });

  it('keeps fresh facts while dropping the stale ones', () => {
    const section = buildLearnerProfileSection(
      profile({
        targetScore: 7,
        targetScoreFetchedAt: new Date('2026-08-16T01:00:00.000Z'),
        examDate: '2026-11-20',
        examDateFetchedAt: new Date('2026-08-01T00:00:00.000Z'),
      }),
      NOW,
      TTL,
    );
    expect(section).toContain('Mục tiêu band: 7');
    expect(section).not.toContain('Ngày thi');
  });

  it('returns undefined for missing profiles', () => {
    expect(buildLearnerProfileSection(null, NOW, TTL)).toBeUndefined();
    expect(buildLearnerProfileSection(undefined, NOW, TTL)).toBeUndefined();
  });
});
