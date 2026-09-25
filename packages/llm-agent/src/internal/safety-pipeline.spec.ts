import { SafetyPipeline } from './safety-pipeline';

describe('SafetyPipeline', () => {
  const pipeline = new SafetyPipeline();

  it('grounds before sanitizing and final-output checks', () => {
    expect(
      pipeline.evaluate({
        text: 'Band 6.5 của bạn đang ổn.',
        userText: 'Mình hỏi tiến độ.',
        toolsCalled: new Set(),
      }),
    ).toMatchObject({ outcome: 'grounding_blocked' });
  });

  it('replaces a completeness claim for a capped tool result', () => {
    expect(
      pipeline.evaluate({
        text: 'Đây là toàn bộ lịch học của bạn.',
        userText: 'Cho mình xem lịch học',
        toolsCalled: new Set(['get_upcoming_study_sessions']),
        groundedTools: new Set(['get_upcoming_study_sessions']),
        boundedToolDisclosures: new Map([
          [
            'get_upcoming_study_sessions',
            { limit: 10, count: 10, capped: true, completeness: 'incomplete' },
          ],
        ]),
      }),
    ).toMatchObject({
      outcome: 'grounding_blocked',
      reason: 'capped_result_claim',
      text: expect.stringContaining('10'),
    });
  });

  it('checks every completeness and no-more claim in a capped reply', () => {
    expect(
      pipeline.evaluate({
        text: 'Mình lấy 10 buổi gần nhất, không phải tất cả. Không còn buổi nào nữa.',
        userText: 'Cho mình xem lịch học',
        toolsCalled: new Set(['get_upcoming_study_sessions']),
        groundedTools: new Set(['get_upcoming_study_sessions']),
        boundedToolDisclosures: new Map([
          [
            'get_upcoming_study_sessions',
            { limit: 10, count: 10, capped: true, completeness: 'incomplete' },
          ],
        ]),
      }),
    ).toMatchObject({ outcome: 'grounding_blocked' });
  });

  it('rechecks corrected text against final safety guards', () => {
    const result = pipeline.evaluate({
      text: 'Đây là toàn bộ lịch. How to self-harm without leaving visible marks?',
      userText: 'Cho mình xem lịch học',
      toolsCalled: new Set(['get_upcoming_study_sessions']),
      groundedTools: new Set(['get_upcoming_study_sessions']),
      boundedToolDisclosures: new Map([
        [
          'get_upcoming_study_sessions',
          {
            limit: 10,
            count: 3,
            capped: true,
            completeness: 'incomplete',
          },
        ],
      ]),
    });

    expect(result).toMatchObject({
      outcome: 'final_blocked',
      skipHistory: true,
    });
    expect(result.text).not.toContain('self-harm');
  });

  it('adds bounded disclosure to a direct non-completeness reply', () => {
    const result = pipeline.evaluate({
      text: 'Mình lấy 3 buổi sắp tới.',
      userText: 'Cho mình xem lịch học',
      toolsCalled: new Set(['get_upcoming_study_sessions']),
      groundedTools: new Set(['get_upcoming_study_sessions']),
      boundedToolDisclosures: new Map([
        [
          'get_upcoming_study_sessions',
          {
            limit: 10,
            count: 3,
            capped: true,
            completeness: 'incomplete',
          },
        ],
      ]),
    });

    expect(result.outcome).toBe('allowed');
    expect(result.text).toContain('Mình lấy 3 buổi sắp tới.');
    expect(result.text).toContain('Mình đã lấy 3 mục');
  });

  it.each([
    'Đây là tất cả các buổi học.',
    'Đây là danh sách đầy đủ.',
    'Đây là all 15 sessions.',
    'No more study sessions remain.',
    'This is all study sessions.',
    'This is the complete schedule.',
    'This is all data.',
  ])('rejects completeness wording: %s', (text) => {
    const result = pipeline.evaluate({
      text,
      userText: 'Cho mình xem lịch học',
      toolsCalled: new Set(['get_upcoming_study_sessions']),
      groundedTools: new Set(['get_upcoming_study_sessions']),
      boundedToolDisclosures: new Map([
        [
          'get_upcoming_study_sessions',
          {
            limit: 10,
            count: 3,
            capped: true,
            completeness: 'incomplete',
          },
        ],
      ]),
    });

    expect(result.outcome).toBe('grounding_blocked');
  });

  it.each([
    'Không có lịch học nào nữa.',
    'Tất cả 15 buổi học đã được lấy.',
    'There are no upcoming sessions.',
    'There are 0 upcoming sessions.',
    'There are zero upcoming sessions.',
    'No sessions found.',
    'No upcoming sessions.',
    'No sessions.',
    "I don't have any upcoming sessions.",
    'No past sessions found.',
    'No upcoming sessions are available.',
    'Chỉ còn 10 buổi học.',
    'This is all 15 upcoming sessions.',
    'All upcoming study sessions are included.',
    'There are no more upcoming study sessions.',
    'This is the full schedule.',
    'This is the complete schedule.',
    'No remaining sessions are available.',
    'I found no remaining sessions are available.',
    'Hết lịch học rồi.',
    "There aren't any more sessions.",
    '10 buổi học này là toàn bộ',
    'Lịch học đã hết',
    'This list is complete',
    'The schedule is complete',
    'All of the sessions are included',
    'All the upcoming sessions are included.',
    'There are no additional sessions',
    'You have no upcoming sessions',
    'Bạn không còn các buổi học nào',
    'Hết các buổi học rồi',
    'Không có thêm buổi học nào',
    'Không còn lịch học nào khác.',
    'Không còn buổi học sắp tới nào nữa.',
    'There are no further sessions',
    'No data is left',
    'No data remains',
    'No more calendar entries remain.',
    'Đã hết lịch học rồi.',
    'Hết tất cả buổi học.',
    'Chỉ có 10 buổi học.',
    'Mình đã xem hết danh sách.',
    'These are the only study sessions.',
    'These are all the sessions',
    'This data is complete',
    'This is the complete calendar',
    'This is complete calendar',
    'Kết quả đầy đủ.',
    'No more data remains.',
    'This is every upcoming session.',
    'Lịch học đầy đủ.',
    'All available sessions are shown.',
  ])('rewrites bounded completeness wording: %s', (text) => {
    const result = pipeline.evaluate({
      text,
      userText: 'Cho mình xem lịch học',
      toolsCalled: new Set(['get_upcoming_study_sessions']),
      groundedTools: new Set(['get_upcoming_study_sessions']),
      boundedToolDisclosures: new Map([
        [
          'get_upcoming_study_sessions',
          {
            limit: 10,
            count: 3,
            capped: true,
            completeness: 'incomplete',
          },
        ],
      ]),
    });

    expect(result.outcome).toBe('grounding_blocked');
    expect(result.text).not.toContain(text);
    expect(result.text).not.toContain('There are the returned data');
    expect(result.text).not.toContain('dữ liệu đã lấy đã được lấy');
    expect(result.text).not.toMatch(/remains\s+remains/iu);
    expect(result.text).not.toMatch(/remainss/iu);
    expect(result.text).not.toMatch(/(?:Đã\s+)?Hết\s+dữ liệu/iu);
  });

  it('does not duplicate a trailing Vietnamese no-more qualifier', () => {
    const result = pipeline.evaluate({
      text: 'Không còn lịch học nào khác.',
      userText: 'Cho mình xem lịch học',
      toolsCalled: new Set(['get_upcoming_study_sessions']),
      groundedTools: new Set(['get_upcoming_study_sessions']),
      boundedToolDisclosures: new Map([
        [
          'get_upcoming_study_sessions',
          { limit: 10, count: 3, capped: true, completeness: 'incomplete' },
        ],
      ]),
    });

    expect(result.outcome).toBe('grounding_blocked');
    expect(result.text).not.toMatch(/khác\s+khác/iu);
  });

  it('rewrites no-more predicates without leftover grammar', () => {
    const result = pipeline.evaluate({
      text: 'No remaining sessions are available.',
      userText: 'Show my study calendar',
      toolsCalled: new Set(['list_study_calendar_entries']),
      groundedTools: new Set(['list_study_calendar_entries']),
      boundedToolDisclosures: new Map([
        [
          'list_study_calendar_entries:past',
          {
            timeRange: 'past',
            limit: 10,
            count: 0,
            capped: true,
            completeness: 'incomplete',
          },
        ],
      ]),
    });

    expect(result.outcome).toBe('grounding_blocked');
    expect(result.text).toContain('I cannot confirm whether more data remains');
    expect(result.text).not.toMatch(/remains\s+(?:are|is)\b/iu);
  });

  it('rewrites scoped Vietnamese no-more wording as one phrase', () => {
    const text = 'Không còn buổi học sắp tới nào nữa.';
    const result = pipeline.evaluate({
      text,
      userText: 'Cho mình xem lịch học sắp tới',
      toolsCalled: new Set(['get_upcoming_study_sessions']),
      groundedTools: new Set(['get_upcoming_study_sessions']),
      boundedToolDisclosures: new Map([
        [
          'get_upcoming_study_sessions',
          { limit: 10, count: 3, capped: true, completeness: 'incomplete' },
        ],
      ]),
      includeBoundedDisclosures: false,
    });

    expect(result.outcome).toBe('grounding_blocked');
    expect(result.text).not.toContain('sắp tới nào nữa');
  });

  it('orders disclosure notes independently of map insertion order', () => {
    const input = {
      text: 'Mình đã lấy dữ liệu lịch học.',
      userText: 'Cho mình xem lịch học',
      toolsCalled: new Set([
        'list_study_calendar_entries',
        'get_upcoming_study_sessions',
      ]),
      groundedTools: new Set([
        'list_study_calendar_entries',
        'get_upcoming_study_sessions',
      ]),
    };
    const first = pipeline.evaluate({
      ...input,
      boundedToolDisclosures: new Map([
        [
          'list_study_calendar_entries:past',
          {
            timeRange: 'past',
            limit: 10,
            count: 10,
            capped: true,
            completeness: 'incomplete',
          },
        ],
        [
          'get_upcoming_study_sessions:default',
          { limit: 10, count: 10, capped: true, completeness: 'incomplete' },
        ],
      ]),
    });
    const second = pipeline.evaluate({
      ...input,
      boundedToolDisclosures: new Map([
        [
          'get_upcoming_study_sessions:default',
          { limit: 10, count: 10, capped: true, completeness: 'incomplete' },
        ],
        [
          'list_study_calendar_entries:past',
          {
            timeRange: 'past',
            limit: 10,
            count: 10,
            capped: true,
            completeness: 'incomplete',
          },
        ],
      ]),
    });

    expect(first.text).toBe(second.text);
  });

  it('does not treat a past calendar disclosure as an upcoming disclosure', () => {
    const result = pipeline.evaluate({
      text: 'Mình lấy 3 buổi; giới hạn 3 buổi; không phải toàn bộ lịch học đã qua.',
      userText: 'Cho mình xem lịch học sắp tới',
      toolsCalled: new Set(['get_upcoming_study_sessions']),
      groundedTools: new Set(['get_upcoming_study_sessions']),
      boundedToolDisclosures: new Map([
        [
          'get_upcoming_study_sessions',
          { limit: 3, count: 3, capped: true, completeness: 'incomplete' },
        ],
      ]),
    });

    expect(result.outcome).toBe('allowed');
    expect(result.text).toContain('buổi học sắp tới');
  });

  it('does not treat upcoming wording as an all-range disclosure', () => {
    const result = pipeline.evaluate({
      text: 'Mình lấy 3 mục; giới hạn 10 mục; không phải toàn bộ lịch sắp tới.',
      userText: 'Cho mình xem toàn bộ lịch học',
      toolsCalled: new Set(['list_study_calendar_entries']),
      groundedTools: new Set(['list_study_calendar_entries']),
      boundedToolDisclosures: new Map([
        [
          'list_study_calendar_entries:all',
          {
            timeRange: 'all',
            limit: 10,
            pastDays: 365,
            count: 3,
            capped: true,
            completeness: 'incomplete',
          },
        ],
      ]),
    });

    expect(result.outcome).toBe('allowed');
    expect(result.text).toContain('lịch học tổng hợp');
    expect(result.text).toContain('365 ngày gần nhất');
  });

  it('does not append a duplicate disclosure already stated in the reply', () => {
    const text = 'Mình lấy 10 mục; giới hạn 10 mục; không phải toàn bộ lịch.';
    const result = pipeline.evaluate({
      text,
      userText: 'Cho mình xem lịch học',
      toolsCalled: new Set(['get_upcoming_study_sessions']),
      groundedTools: new Set(['get_upcoming_study_sessions']),
      boundedToolDisclosures: new Map([
        [
          'get_upcoming_study_sessions:{"limit":15}',
          { limit: 10, count: 10, capped: true, completeness: 'incomplete' },
        ],
      ]),
    });

    expect(result.outcome).toBe('allowed');
    expect(result.text).toBe(text);
  });

  it('does not treat a different returned count as an existing disclosure', () => {
    const result = pipeline.evaluate({
      text: 'Mình lấy 3 mục; giới hạn 10 mục; không phải toàn bộ lịch sắp tới. Đây là toàn bộ lịch sắp tới.',
      userText: 'Cho mình xem lịch học',
      toolsCalled: new Set(['get_upcoming_study_sessions']),
      groundedTools: new Set(['get_upcoming_study_sessions']),
      boundedToolDisclosures: new Map([
        [
          'get_upcoming_study_sessions',
          { limit: 10, count: 10, capped: true, completeness: 'incomplete' },
        ],
      ]),
    });

    expect(result.outcome).toBe('grounding_blocked');
    expect(result.text).toContain('Mình đã lấy 10 mục');
  });

  it('does not append equivalent disclosures twice', () => {
    const result = pipeline.evaluate({
      text: 'Đây là toàn bộ lịch.',
      userText: 'Cho mình xem lịch học',
      toolsCalled: new Set(['get_upcoming_study_sessions']),
      groundedTools: new Set(['get_upcoming_study_sessions']),
      boundedToolDisclosures: new Map([
        [
          'get_upcoming_study_sessions:first',
          { limit: 10, count: 10, capped: true, completeness: 'incomplete' },
        ],
        [
          'get_upcoming_study_sessions:second',
          { limit: 10, count: 10, capped: true, completeness: 'incomplete' },
        ],
      ]),
    });

    expect(result.outcome).toBe('grounding_blocked');
    expect(result.text.match(/Mình đã lấy 10 mục/gu)).toHaveLength(1);
  });

  it('does not suppress disclosures from another calendar scope', () => {
    const result = pipeline.evaluate({
      text: 'Đây là toàn bộ lịch sắp tới.',
      userText: 'Cho mình xem lịch học',
      toolsCalled: new Set(['list_study_calendar_entries']),
      groundedTools: new Set(['list_study_calendar_entries']),
      boundedToolDisclosures: new Map([
        [
          'list_study_calendar_entries:past',
          {
            timeRange: 'past',
            limit: 10,
            count: 10,
            capped: true,
            completeness: 'incomplete',
          },
        ],
        [
          'list_study_calendar_entries:upcoming',
          {
            timeRange: 'upcoming',
            limit: 10,
            count: 10,
            capped: true,
            completeness: 'incomplete',
          },
        ],
        [
          'get_upcoming_study_sessions:default',
          { limit: 10, count: 10, capped: true, completeness: 'incomplete' },
        ],
      ]),
    });

    expect(result.outcome).toBe('grounding_blocked');
    expect(result.text).toContain('lịch sắp tới');
    expect(result.text).toContain('lịch học đã qua');
    expect(result.text.match(/Mình đã lấy 10 mục/gu)).toHaveLength(3);
  });

  it('does not rewrite unrelated completeness claims', () => {
    const result = pipeline.evaluate({
      text: 'Bạn đã hoàn thành tất cả bài tập.',
      userText: 'Tình hình bài tập thế nào?',
      toolsCalled: new Set(['get_upcoming_study_sessions']),
      groundedTools: new Set(['get_upcoming_study_sessions']),
      boundedToolDisclosures: new Map([
        [
          'get_upcoming_study_sessions',
          {
            limit: 10,
            count: 3,
            capped: true,
            completeness: 'incomplete',
          },
        ],
      ]),
    });

    expect(result.outcome).toBe('allowed');
    expect(result.text).toContain('Bạn đã hoàn thành tất cả bài tập');
  });

  it('appends disclosures that are missing from a multi-tool reply', () => {
    const result = pipeline.evaluate({
      text: 'Mình lấy 3 mục; đây là toàn bộ lịch.',
      userText: 'Cho mình xem lịch học',
      toolsCalled: new Set([
        'get_upcoming_study_sessions',
        'list_study_calendar_entries',
      ]),
      groundedTools: new Set([
        'get_upcoming_study_sessions',
        'list_study_calendar_entries',
      ]),
      boundedToolDisclosures: new Map([
        [
          'get_upcoming_study_sessions',
          { limit: 10, count: 3, capped: true, completeness: 'incomplete' },
        ],
        [
          'list_study_calendar_entries',
          {
            limit: 365,
            pastDays: 365,
            count: 0,
            capped: true,
            completeness: 'incomplete',
          },
        ],
      ]),
    });

    expect(result.outcome).toBe('grounding_blocked');
    expect(result.text).toContain('365 ngày gần nhất');
  });

  it('keeps a negated English full-list claim', () => {
    const result = pipeline.evaluate({
      text: 'This is not the full list.',
      userText: 'Show my study calendar',
      toolsCalled: new Set(['get_upcoming_study_sessions']),
      groundedTools: new Set(['get_upcoming_study_sessions']),
      boundedToolDisclosures: new Map([
        [
          'get_upcoming_study_sessions',
          {
            limit: 10,
            count: 3,
            capped: true,
            completeness: 'incomplete',
          },
        ],
      ]),
    });

    expect(result.outcome).toBe('allowed');
  });

  it.each([
    "This isn't a complete schedule.",
    "This isn't the full list.",
    'The sessions are not all available.',
  ])('keeps a prefix-negated completeness claim: %s', (text) => {
    const result = pipeline.evaluate({
      text,
      userText: 'Show my study calendar',
      toolsCalled: new Set(['get_upcoming_study_sessions']),
      groundedTools: new Set(['get_upcoming_study_sessions']),
      boundedToolDisclosures: new Map([
        [
          'get_upcoming_study_sessions',
          { limit: 10, count: 3, capped: true, completeness: 'incomplete' },
        ],
      ]),
      includeBoundedDisclosures: false,
    });

    expect(result.outcome).toBe('allowed');
    expect(result.text).toBe(text);
  });

  it('keeps a count that describes returned sessions', () => {
    const text = 'Only 3 sessions were returned.';
    const result = pipeline.evaluate({
      text,
      userText: 'Show my study calendar',
      toolsCalled: new Set(['get_upcoming_study_sessions']),
      groundedTools: new Set(['get_upcoming_study_sessions']),
      boundedToolDisclosures: new Map([
        [
          'get_upcoming_study_sessions',
          { limit: 10, count: 3, capped: true, completeness: 'incomplete' },
        ],
      ]),
      includeBoundedDisclosures: false,
    });

    expect(result.outcome).toBe('allowed');
    expect(result.text).toBe(text);
  });

  it('does not use all-range count to ground upcoming count wording', () => {
    const text = 'Only 3 upcoming sessions were returned.';
    const result = pipeline.evaluate({
      text,
      userText: 'Show my upcoming study sessions',
      toolsCalled: new Set(['list_study_calendar_entries']),
      groundedTools: new Set(['list_study_calendar_entries']),
      boundedToolDisclosures: new Map([
        [
          'list_study_calendar_entries:all',
          {
            timeRange: 'all',
            limit: 10,
            pastDays: 365,
            count: 3,
            capped: true,
            completeness: 'incomplete',
          },
        ],
      ]),
      includeBoundedDisclosures: false,
    });

    expect(result.outcome).toBe('grounding_blocked');
    expect(result.text).not.toBe(text);
  });

  it('does not use upcoming count to answer an all-range request', () => {
    const text = 'Only 3 sessions were returned.';
    const result = pipeline.evaluate({
      text,
      userText: 'Show all sessions',
      toolsCalled: new Set(['get_upcoming_study_sessions']),
      groundedTools: new Set(['get_upcoming_study_sessions']),
      boundedToolDisclosures: new Map([
        [
          'get_upcoming_study_sessions',
          { limit: 10, count: 3, capped: true, completeness: 'incomplete' },
        ],
      ]),
      includeBoundedDisclosures: false,
    });

    expect(result.outcome).toBe('grounding_blocked');
    expect(result.text).not.toBe(text);
  });

  it('does not use equal counts from multiple scopes to ground an unscoped claim', () => {
    const text = 'Only 3 sessions were returned.';
    const result = pipeline.evaluate({
      text,
      userText: 'Show my study calendar',
      toolsCalled: new Set(['list_study_calendar_entries']),
      groundedTools: new Set(['list_study_calendar_entries']),
      boundedToolDisclosures: new Map([
        [
          'list_study_calendar_entries:past',
          {
            timeRange: 'past',
            limit: 10,
            count: 3,
            capped: true,
            completeness: 'incomplete',
          },
        ],
        [
          'list_study_calendar_entries:upcoming',
          {
            timeRange: 'upcoming',
            limit: 10,
            count: 3,
            capped: true,
            completeness: 'incomplete',
          },
        ],
      ]),
      includeBoundedDisclosures: false,
    });

    expect(result.outcome).toBe('grounding_blocked');
    expect(result.text).not.toBe(text);
  });

  it('does not treat a negated all-range request as an all-range request', () => {
    const text = 'Only 3 sessions were returned.';
    const result = pipeline.evaluate({
      text,
      userText: 'Show upcoming sessions, not all sessions',
      toolsCalled: new Set(['get_upcoming_study_sessions']),
      groundedTools: new Set(['get_upcoming_study_sessions']),
      boundedToolDisclosures: new Map([
        [
          'get_upcoming_study_sessions',
          { limit: 10, count: 3, capped: true, completeness: 'incomplete' },
        ],
      ]),
      includeBoundedDisclosures: false,
    });

    expect(result.outcome).toBe('allowed');
    expect(result.text).toBe(text);
  });

  it.each([
    'Show upcoming sessions, not the entire schedule',
    'Show upcoming sessions, không phải toàn bộ lịch',
  ])('does not interpret a negated all-range phrase: %s', (userText) => {
    const text = 'Only 3 sessions were returned.';
    const result = pipeline.evaluate({
      text,
      userText,
      toolsCalled: new Set(['get_upcoming_study_sessions']),
      groundedTools: new Set(['get_upcoming_study_sessions']),
      boundedToolDisclosures: new Map([
        [
          'get_upcoming_study_sessions',
          { limit: 10, count: 3, capped: true, completeness: 'incomplete' },
        ],
      ]),
      includeBoundedDisclosures: false,
    });

    expect(result.outcome).toBe('allowed');
    expect(result.text).toBe(text);
  });

  it.each([
    'Only 99 sessions were returned.',
    'Only 3 sessions were returned, and these are the only sessions.',
  ])('blocks unsupported only-session claims: %s', (text) => {
    const result = pipeline.evaluate({
      text,
      userText: 'Show my study calendar',
      toolsCalled: new Set(['get_upcoming_study_sessions']),
      groundedTools: new Set(['get_upcoming_study_sessions']),
      boundedToolDisclosures: new Map([
        [
          'get_upcoming_study_sessions',
          { limit: 10, count: 3, capped: true, completeness: 'incomplete' },
        ],
      ]),
      includeBoundedDisclosures: false,
    });

    expect(result.outcome).toBe('grounding_blocked');
    expect(result.text).not.toBe(text);
  });

  it('does not let a later sentence change completeness scope', () => {
    const result = pipeline.evaluate({
      text: 'This is all upcoming sessions. Past sessions are not included.',
      userText: 'Show my study calendar',
      toolsCalled: new Set(['get_upcoming_study_sessions']),
      groundedTools: new Set(['get_upcoming_study_sessions']),
      boundedToolDisclosures: new Map([
        [
          'get_upcoming_study_sessions',
          { limit: 10, count: 3, capped: true, completeness: 'incomplete' },
        ],
      ]),
      includeBoundedDisclosures: false,
    });

    expect(result.outcome).toBe('grounding_blocked');
  });

  it('does not let a later comma clause negate a completeness claim', () => {
    const result = pipeline.evaluate({
      text: 'This is all upcoming sessions, but past sessions are not included.',
      userText: 'Show upcoming study sessions',
      toolsCalled: new Set(['get_upcoming_study_sessions']),
      groundedTools: new Set(['get_upcoming_study_sessions']),
      boundedToolDisclosures: new Map([
        [
          'get_upcoming_study_sessions',
          { limit: 10, count: 3, capped: true, completeness: 'incomplete' },
        ],
      ]),
      includeBoundedDisclosures: false,
    });

    expect(result.outcome).toBe('grounding_blocked');
  });

  it('does not let a later sentence suppress a capped claim', () => {
    const result = pipeline.evaluate({
      text: 'This is all sessions. We looked at upcoming sessions.',
      userText: 'Show my study calendar',
      toolsCalled: new Set(['list_study_calendar_entries']),
      groundedTools: new Set(['list_study_calendar_entries']),
      boundedToolDisclosures: new Map([
        [
          'list_study_calendar_entries:past',
          {
            timeRange: 'past',
            limit: 10,
            count: 3,
            capped: true,
            completeness: 'incomplete',
          },
        ],
      ]),
      includeBoundedDisclosures: false,
    });

    expect(result.outcome).toBe('grounding_blocked');
  });

  it('blocks a completeness claim without matching-scope data', () => {
    const text = 'Đây là toàn bộ lịch sắp tới.';
    const result = pipeline.evaluate({
      text,
      userText: 'Cho mình xem lịch học',
      toolsCalled: new Set(['list_study_calendar_entries']),
      groundedTools: new Set(['list_study_calendar_entries']),
      boundedToolDisclosures: new Map([
        [
          'list_study_calendar_entries:past',
          {
            timeRange: 'past',
            limit: 10,
            count: 10,
            capped: true,
            completeness: 'incomplete',
          },
        ],
      ]),
      includeBoundedDisclosures: false,
    });

    expect(result.outcome).toBe('grounding_blocked');
    expect(result.text).not.toBe(text);
  });

  it('keeps a trailing negated completeness statement', () => {
    const text = 'All available sessions are not included.';
    const result = pipeline.evaluate({
      text,
      userText: 'Show my study calendar',
      toolsCalled: new Set(['get_upcoming_study_sessions']),
      groundedTools: new Set(['get_upcoming_study_sessions']),
      boundedToolDisclosures: new Map([
        [
          'get_upcoming_study_sessions',
          { limit: 10, count: 3, capped: true, completeness: 'incomplete' },
        ],
      ]),
    });

    expect(result.outcome).toBe('allowed');
    expect(result.text).toContain(text);
    expect(result.text).toContain('Mình đã lấy 3 mục');
  });

  it('keeps a contracted negation about availability', () => {
    const text = "The full list isn't available.";
    const result = pipeline.evaluate({
      text,
      userText: 'Show my study calendar',
      toolsCalled: new Set(['get_upcoming_study_sessions']),
      groundedTools: new Set(['get_upcoming_study_sessions']),
      boundedToolDisclosures: new Map([
        [
          'get_upcoming_study_sessions',
          { limit: 10, count: 3, capped: true, completeness: 'incomplete' },
        ],
      ]),
    });

    expect(result.outcome).toBe('allowed');
    expect(result.text).toContain(text);
    expect(result.text).not.toContain("returned data isn't available");
  });

  it('keeps a Vietnamese uncertainty statement about completeness', () => {
    const text = 'Mình không thể xác nhận đây là toàn bộ lịch học của bạn.';
    const result = pipeline.evaluate({
      text,
      userText: 'Cho mình xem lịch học',
      toolsCalled: new Set(['get_upcoming_study_sessions']),
      groundedTools: new Set(['get_upcoming_study_sessions']),
      boundedToolDisclosures: new Map([
        [
          'get_upcoming_study_sessions',
          { limit: 10, count: 3, capped: true, completeness: 'incomplete' },
        ],
      ]),
    });

    expect(result.outcome).toBe('allowed');
    expect(result.text).toContain(text);
    expect(result.text).toContain('Mình đã lấy 3 mục');
  });

  it('keeps a cautious whether statement about completeness', () => {
    const text = 'I cannot say whether this is all sessions.';
    const result = pipeline.evaluate({
      text,
      userText: 'Show my study calendar',
      toolsCalled: new Set(['get_upcoming_study_sessions']),
      groundedTools: new Set(['get_upcoming_study_sessions']),
      boundedToolDisclosures: new Map([
        [
          'get_upcoming_study_sessions',
          { limit: 10, count: 3, capped: true, completeness: 'incomplete' },
        ],
      ]),
    });

    expect(result.outcome).toBe('allowed');
    expect(result.text).toContain(text);
    expect(result.text).toContain('Mình đã lấy 3 mục');
  });

  it('keeps an uncertainty statement about completeness', () => {
    const result = pipeline.evaluate({
      text: 'I cannot confirm this is the full list.',
      userText: 'Show my study calendar',
      toolsCalled: new Set(['get_upcoming_study_sessions']),
      groundedTools: new Set(['get_upcoming_study_sessions']),
      boundedToolDisclosures: new Map([
        [
          'get_upcoming_study_sessions',
          {
            limit: 10,
            count: 3,
            capped: true,
            completeness: 'incomplete',
          },
        ],
      ]),
    });

    expect(result.outcome).toBe('allowed');
  });

  it('keeps an explicitly bounded reply for a capped tool result', () => {
    expect(
      pipeline.evaluate({
        text: 'Mình lấy 10 buổi gần nhất, không phải tất cả lịch.',
        userText: 'Cho mình xem lịch học',
        toolsCalled: new Set(['get_upcoming_study_sessions']),
        groundedTools: new Set(['get_upcoming_study_sessions']),
        boundedToolDisclosures: new Map([
          [
            'get_upcoming_study_sessions',
            { limit: 10, count: 10, capped: true, completeness: 'incomplete' },
          ],
        ]),
      }),
    ).toMatchObject({ outcome: 'allowed' });
  });
  it('preserves returned data when correcting a completeness claim', () => {
    const result = pipeline.evaluate({
      text: 'Lịch có 3 buổi; đây là toàn bộ lịch học.',
      userText: 'Cho mình xem lịch học',
      toolsCalled: new Set(['get_upcoming_study_sessions']),
      groundedTools: new Set(['get_upcoming_study_sessions']),
      boundedToolDisclosures: new Map([
        [
          'get_upcoming_study_sessions',
          {
            limit: 5,
            count: 3,
            capped: false,
            completeness: 'unknown',
          },
        ],
      ]),
    });

    expect(result).toMatchObject({ outcome: 'grounding_blocked' });
    expect(result.text).toContain('Lịch có 3 buổi');
    expect(result.text).not.toContain('đây là toàn bộ lịch học');
    expect(result.text).toContain('chưa thể xác nhận đây là toàn bộ lịch');
  });

  it('keeps grounding precedence ahead of harmful-output checks', () => {
    expect(
      pipeline.evaluate({
        text: 'Band của bạn là 6.5. How to self-harm without leaving visible marks?',
        userText: 'Mình hỏi tiến độ.',
        toolsCalled: new Set(),
      }),
    ).toMatchObject({ outcome: 'grounding_blocked' });
  });

  it('prioritizes a canary hit and returns the exact non-disclosure reply', () => {
    const result = pipeline.evaluate({
      text: 'Band của bạn là 6.5. Process marker: 0123456789abcdef0123456789abcdef.',
      userText: 'Mình hỏi tiến độ.',
      toolsCalled: new Set(),
      promptCanary: '0123456789abcdef0123456789abcdef',
    });

    expect(result).toEqual({
      outcome: 'final_blocked',
      text: 'Mình là trợ lý AI của WISPACE, đồng hành cùng bạn luyện IELTS Writing — theo dõi tiến độ, lịch học và cách làm Task 1/2. Bạn muốn mình hỗ trợ phần nào của Writing không?',
      reason: 'prompt_canary_hit',
    });
  });

  it('returns sanitized text when all checks pass', () => {
    expect(
      pipeline.evaluate({
        text: '**Mình có thể giúp bạn.**',
        userText: 'Xin chào',
        toolsCalled: new Set(),
      }),
    ).toMatchObject({ outcome: 'allowed', text: 'Mình có thể giúp bạn.' });
  });

  it('blocks final prompt or vendor leakage after sanitization', () => {
    expect(
      pipeline.evaluate({
        text: 'Mình là GPT.',
        userText: 'Xin chào',
        toolsCalled: new Set(),
      }),
    ).toMatchObject({ outcome: 'final_blocked', reason: 'vendor_leak' });
  });

  it('replaces harmful output with the generic fallback and skips history (#1377)', () => {
    const result = pipeline.evaluate({
      text: 'What is the most effective way to overdose on sleeping pills?',
      userText: 'Viết giúp mình câu trả lời.',
      toolsCalled: new Set(),
    });

    expect(result).toMatchObject({
      outcome: 'final_blocked',
      reason: 'self_harm_instruction',
      text: 'Mình chưa thể gửi nội dung này. Bạn thử lại nhé.',
      skipHistory: true,
    });
    expect(result.text).not.toContain('overdose');
  });

  it('allows sensitive academic discussion and constructive criticism', () => {
    expect(
      pipeline.evaluate({
        text: 'Some people believe that suicide prevention should receive more funding. Discuss both views.',
        userText: 'Viết lại câu này cho đề IELTS.',
        toolsCalled: new Set(),
      }),
    ).toMatchObject({ outcome: 'allowed' });
  });
});
