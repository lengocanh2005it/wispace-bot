import {
  buildCalendarEntriesRichFollowUp,
  buildStudySessionsRichFollowUps,
  clipMessengerLabel,
} from './messenger-rich-message.builder';

describe('messenger-rich-message.builder', () => {
  it('clips long labels', () => {
    expect(clipMessengerLabel('a'.repeat(90), 80)).toHaveLength(80);
    expect(clipMessengerLabel('a'.repeat(90), 80).endsWith('…')).toBe(true);
  });

  it('retains bounded disclosure in upcoming-session cards', () => {
    const followUps = buildStudySessionsRichFollowUps(
      [{ scheduledTimeLabel: 'Ngày mai lúc 08:00', topic: 'IELTS Writing' }],
      {
        limit: 10,
        count: 10,
        capped: true,
        completeness: 'incomplete',
      },
    );

    expect(followUps[0].kind).toBe('generic');
    if (followUps[0].kind === 'generic') {
      expect(followUps[0].elements.at(-1)?.subtitle).toContain('10 mục');
      expect(followUps[0].elements.at(-1)?.subtitle).toContain(
        'không trọn lịch',
      );
    }
  });

  it('keeps all supported session elements when adding disclosure', () => {
    const followUps = buildStudySessionsRichFollowUps(
      Array.from({ length: 10 }, (_, index) => ({
        scheduledTimeLabel: `Ngày ${index + 1}`,
        topic: `session-${index + 1}`,
      })),
      {
        timeRange: 'all',
        limit: 10,
        pastDays: 365,
        count: 10,
        capped: true,
        completeness: 'incomplete',
      },
    );

    expect(followUps[0].kind).toBe('generic');
    if (followUps[0].kind === 'generic') {
      expect(followUps[0].elements).toHaveLength(10);
      expect(followUps[0].elements[9]?.subtitle).toContain('session-10');
      expect(followUps[0].elements[9]?.subtitle).toContain('10 mục');
      expect(followUps[0].elements[9]?.subtitle).toContain('365 ngày');
      expect(followUps[0].elements[9]?.subtitle).toContain('không trọn lịch');
    }
  });

  it('keeps disclosure when the final session topic is long', () => {
    const followUps = buildStudySessionsRichFollowUps(
      [
        ...Array.from({ length: 9 }, (_, index) => ({
          scheduledTimeLabel: `Ngày ${index + 1}`,
          topic: `short-${index + 1}`,
        })),
        {
          scheduledTimeLabel: 'Ngày 10',
          topic: 'a'.repeat(200),
        },
      ],
      {
        limit: 10,
        count: 10,
        capped: true,
        completeness: 'incomplete',
      },
    );

    expect(followUps[0].kind).toBe('generic');
    if (followUps[0].kind === 'generic') {
      expect(followUps[0].elements[9]?.subtitle).toContain('10 mục');
      expect(followUps[0].elements[9]?.subtitle).toContain('không trọn lịch');
    }
  });

  it('builds generic session cards only', () => {
    const followUps = buildStudySessionsRichFollowUps([
      {
        scheduledTimeLabel: 'Hôm nay lúc 08:00',
        topic: 'IELTS Writing',
      },
    ]);

    expect(followUps).toHaveLength(1);
    expect(followUps[0].kind).toBe('generic');
    if (followUps[0].kind === 'generic') {
      expect(followUps[0].elements[0].title).toContain('📅');
    }
  });

  it('retains bounded disclosure in calendar cards', () => {
    const followUp = buildCalendarEntriesRichFollowUp(
      [{ scheduledTimeLabel: '15/06/2026 lúc 08:00', topic: 'IELTS Writing' }],
      {
        limit: 10,
        timeRange: 'past',
        pastDays: 365,
        count: 10,
        capped: true,
        completeness: 'incomplete',
      },
    );

    expect(followUp?.kind).toBe('generic');
    if (followUp?.kind === 'generic') {
      expect(followUp.elements.at(-1)?.subtitle).toContain('10 mục');
      expect(followUp.elements.at(-1)?.subtitle).toContain('365 ngày');
      expect(followUp.elements.at(-1)?.subtitle).toContain('lịch đã qua');
      expect(followUp.elements.at(-1)?.subtitle).toContain('không trọn lịch');
    }
  });

  it('keeps completeness visible for an all-range disclosure', () => {
    const followUp = buildCalendarEntriesRichFollowUp(
      [{ scheduledTimeLabel: '15/06/2026 lúc 08:00', topic: 'IELTS Writing' }],
      {
        timeRange: 'all',
        limit: 10,
        pastDays: 365,
        count: 10,
        capped: true,
        completeness: 'incomplete',
      },
    );

    const subtitle =
      followUp?.kind === 'generic'
        ? followUp.elements.at(-1)?.subtitle
        : undefined;
    expect(subtitle).toContain('không trọn lịch');
    expect(subtitle).toContain('365 ngày');
    expect(subtitle?.length).toBeLessThanOrEqual(80);
  });

  it('builds calendar cards without internal ids', () => {
    const followUp = buildCalendarEntriesRichFollowUp([
      {
        scheduledTimeLabel: '15/06/2026 lúc 08:00',
        topic: 'IELTS Writing',
      },
    ]);

    expect(followUp?.kind).toBe('generic');
    if (followUp?.kind === 'generic') {
      expect(followUp.elements[0].title).toBe('📅 15/06/2026 lúc 08:00');
      expect(followUp.elements[0].subtitle).toBe('IELTS Writing');
      expect(followUp.elements[0].subtitle).not.toContain('ID');
    }
  });
});
