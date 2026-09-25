import {
  AGENT_TOOLS,
  parseAndValidateToolArguments,
  readPastDays,
  readPositiveInteger,
  readPositiveLimit,
  readBoundedToolDisclosure,
  mergeBoundedToolDisclosures,
} from './agent.tools';

/**
 * #679 characterization suite: pins the exact result contract of
 * parseAndValidateToolArguments (error strings, precedence, canonicalArgs)
 * so the zod migration must preserve it byte-for-byte.
 */
describe('parseAndValidateToolArguments contract (#679)', () => {
  it('rejects an unknown tool', () => {
    expect(parseAndValidateToolArguments('nope', '{}')).toEqual({
      ok: false,
      error: 'Tool không được hỗ trợ',
    });
  });

  it('rejects malformed JSON', () => {
    expect(parseAndValidateToolArguments('get_user_goals', '{oops')).toEqual({
      ok: false,
      error: 'Invalid tool arguments JSON',
    });
  });

  it('treats empty args as an empty object', () => {
    const result = parseAndValidateToolArguments('get_user_goals', '  ');
    expect(result).toEqual({
      ok: true,
      args: {},
      canonicalArgs: '{}',
    });
  });

  it('rejects non-object payloads', () => {
    expect(parseAndValidateToolArguments('get_user_goals', '[1,2]')).toEqual({
      ok: false,
      error: 'Tool arguments must be a JSON object',
    });
  });

  it('rejects unknown arguments', () => {
    expect(
      parseAndValidateToolArguments(
        'reschedule_study_session',
        JSON.stringify({ foo: 1 }),
      ),
    ).toEqual({ ok: false, error: 'Unknown tool argument: foo' });
  });

  it('rejects wrong types', () => {
    expect(
      parseAndValidateToolArguments(
        'get_upcoming_study_sessions',
        JSON.stringify({ limit: '5' }),
      ),
    ).toEqual({ ok: false, error: 'Invalid tool argument: limit' });
    expect(
      parseAndValidateToolArguments(
        'get_upcoming_study_sessions',
        JSON.stringify({ limit: true }),
      ),
    ).toEqual({ ok: false, error: 'Invalid tool argument: limit' });
  });

  it('rejects unsafe integers instead of clamping them', () => {
    for (const limit of [Number.MAX_SAFE_INTEGER + 1, 1e20]) {
      expect(
        parseAndValidateToolArguments(
          'get_upcoming_study_sessions',
          JSON.stringify({ limit }),
        ),
      ).toEqual({ ok: false, error: 'Invalid tool argument: limit' });
    }
  });

  it('rejects non-finite numbers', () => {
    expect(
      parseAndValidateToolArguments(
        'get_upcoming_study_sessions',
        '{"limit": 1e9999}',
      ),
    ).toEqual({ ok: false, error: 'Invalid tool argument: limit' });
  });

  it('accepts over-limit integers for reader clamping', () => {
    expect(
      parseAndValidateToolArguments(
        'get_upcoming_study_sessions',
        JSON.stringify({ limit: 15 }),
      ),
    ).toEqual({
      ok: true,
      args: { limit: 10 },
      requestedArgs: { limit: 15 },
      canonicalArgs: '{"limit":15}',
    });
    expect(
      parseAndValidateToolArguments(
        'list_study_calendar_entries',
        JSON.stringify({ pastDays: 9999 }),
      ),
    ).toMatchObject({
      ok: true,
      args: { pastDays: 365 },
      requestedArgs: { pastDays: 9999 },
    });
  });

  it('rejects fractional and non-positive limit values', () => {
    for (const limit of [5.5, 0, -1]) {
      expect(
        parseAndValidateToolArguments(
          'get_upcoming_study_sessions',
          JSON.stringify({ limit }),
        ),
      ).toEqual({ ok: false, error: 'Invalid tool argument: limit' });
    }
  });

  it('rejects fractional and non-positive calendar identifiers', () => {
    for (const calendarId of [12.7, 0, -1]) {
      expect(
        parseAndValidateToolArguments(
          'reschedule_study_session',
          JSON.stringify({ calendarId, schedulingMode: 'explicit' }),
        ),
      ).toEqual({ ok: false, error: 'Invalid tool argument: calendarId' });
    }
  });

  it('declares positive integer and maximum bounds in provider schemas', () => {
    const upcoming = AGENT_TOOLS.find(
      (tool) => tool.name === 'get_upcoming_study_sessions',
    );
    const calendar = AGENT_TOOLS.find(
      (tool) => tool.name === 'list_study_calendar_entries',
    );
    const reschedule = AGENT_TOOLS.find(
      (tool) => tool.name === 'reschedule_study_session',
    );

    expect(upcoming?.parameters).toMatchObject({
      properties: { limit: { type: 'integer', minimum: 1, maximum: 10 } },
    });
    expect(calendar?.parameters).toMatchObject({
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 10 },
        pastDays: { type: 'integer', minimum: 1, maximum: 365 },
      },
    });
    expect(reschedule?.parameters).toMatchObject({
      properties: { calendarId: { type: 'integer', minimum: 1 } },
    });
  });

  it('keeps reader fallback and cap behavior for valid values', () => {
    expect(readPositiveLimit(undefined, 5)).toBe(5);
    expect(readPositiveLimit(15, 5)).toBe(10);
    expect(readPastDays(undefined)).toBe(90);
    expect(readPastDays(9999)).toBe(365);
  });

  it('does not merge different bounded scopes into fabricated facts', () => {
    expect(
      mergeBoundedToolDisclosures(
        {
          limit: 10,
          pastDays: 365,
          count: 8,
          capped: true,
          completeness: 'incomplete',
        },
        {
          limit: 5,
          count: 3,
          capped: true,
          completeness: 'incomplete',
        },
      ),
    ).toEqual({
      limit: 10,
      pastDays: 365,
      count: 8,
      capped: true,
      completeness: 'incomplete',
    });
  });

  it('preserves time range when merging the same bounded scope', () => {
    expect(
      mergeBoundedToolDisclosures(
        {
          timeRange: 'past',
          limit: 10,
          pastDays: 365,
          capped: true,
          completeness: 'incomplete',
        },
        {
          timeRange: 'past',
          limit: 10,
          pastDays: 365,
          capped: false,
          completeness: 'unknown',
        },
      ),
    ).toEqual({
      timeRange: 'past',
      limit: 10,
      pastDays: 365,
      capped: true,
      completeness: 'incomplete',
    });
  });

  it('validates bounded disclosure metadata with the runtime schema', () => {
    expect(
      readBoundedToolDisclosure({
        requestedLimit: 15,
        effectiveLimit: 10,
        requestedPastDays: 9999,
        effectivePastDays: 365,
        count: 10,
        capped: true,
        completeness: 'incomplete',
      }),
    ).toEqual({
      limit: 10,
      requestedLimit: 15,
      requestedPastDays: 9999,
      pastDays: 365,
      count: 10,
      capped: true,
      completeness: 'incomplete',
    });
    expect(
      readBoundedToolDisclosure({
        effectiveLimit: 10.5,
        capped: false,
        completeness: 'unknown',
      }),
    ).toBeUndefined();
    expect(
      readBoundedToolDisclosure({
        effectiveLimit: 10,
        capped: true,
        completeness: 'unknown',
      }),
    ).toBeUndefined();
  });

  it('rejects invalid values when readers are called directly', () => {
    expect(() => readPositiveLimit(true, 5)).toThrow();
    expect(() => readPositiveLimit(2.9, 5)).toThrow();
    expect(() => readPastDays(false)).toThrow();
    expect(() => readPositiveInteger(12.7)).toThrow();
    expect(() => readPositiveLimit(Number.MAX_SAFE_INTEGER + 1, 5)).toThrow();
    expect(() => readPositiveInteger(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });

  it('rejects enum violations', () => {
    expect(
      parseAndValidateToolArguments(
        'list_study_calendar_entries',
        JSON.stringify({ timeRange: 'bogus' }),
      ),
    ).toEqual({ ok: false, error: 'Invalid tool argument: timeRange' });
  });

  it('rejects missing required arguments', () => {
    expect(
      parseAndValidateToolArguments('reschedule_study_session', '{}'),
    ).toEqual({ ok: false, error: 'Missing tool argument: calendarId' });
  });

  it('allowMissingRequired skips only the required-presence check', () => {
    expect(
      parseAndValidateToolArguments('reschedule_study_session', '{}', {
        allowMissingRequired: true,
      }).ok,
    ).toBe(true);
    expect(
      parseAndValidateToolArguments(
        'reschedule_study_session',
        JSON.stringify({ calendarId: 'x' }),
        { allowMissingRequired: true },
      ),
    ).toEqual({ ok: false, error: 'Invalid tool argument: calendarId' });
    expect(
      parseAndValidateToolArguments(
        'reschedule_study_session',
        JSON.stringify({ foo: 1 }),
        { allowMissingRequired: true },
      ),
    ).toEqual({ ok: false, error: 'Unknown tool argument: foo' });
  });

  it('reports unknown before invalid before missing (precedence)', () => {
    expect(
      parseAndValidateToolArguments(
        'reschedule_study_session',
        JSON.stringify({ foo: 1, calendarId: 'x' }),
      ),
    ).toEqual({ ok: false, error: 'Unknown tool argument: foo' });
    expect(
      parseAndValidateToolArguments(
        'reschedule_study_session',
        JSON.stringify({ calendarId: 'x' }),
      ),
    ).toEqual({ ok: false, error: 'Invalid tool argument: calendarId' });
  });

  it('returns stable key-sorted canonicalArgs on success', () => {
    const result = parseAndValidateToolArguments(
      'list_study_calendar_entries',
      JSON.stringify({ limit: 3, timeRange: 'past' }),
    );
    expect(result).toEqual({
      ok: true,
      args: { limit: 3, timeRange: 'past' },
      canonicalArgs: '{"limit":3,"timeRange":"past"}',
    });
  });
});
