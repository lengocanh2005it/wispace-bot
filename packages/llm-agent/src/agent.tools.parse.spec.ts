import { parseAndValidateToolArguments } from './agent.tools';

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

  it('rejects non-finite numbers', () => {
    expect(
      parseAndValidateToolArguments(
        'get_upcoming_study_sessions',
        '{"limit": 1e9999}',
      ),
    ).toEqual({ ok: false, error: 'Invalid tool argument: limit' });
  });

  it('accepts non-integer numbers (flooring is handler policy)', () => {
    const result = parseAndValidateToolArguments(
      'get_upcoming_study_sessions',
      JSON.stringify({ limit: 5.5 }),
    );
    expect(result.ok).toBe(true);
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
