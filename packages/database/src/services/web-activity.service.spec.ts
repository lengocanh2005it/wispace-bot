import { ConfigService } from '@nestjs/config';
import { WebActivityService, normalizeToUtcIso } from './web-activity.service';

function makeConfig(values: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

describe('normalizeToUtcIso', () => {
  it('appends Z when no timezone designator is present', () => {
    expect(normalizeToUtcIso('2026-08-29T10:00:00')).toBe(
      '2026-08-29T10:00:00.000Z',
    );
  });
  it('keeps an explicit offset', () => {
    expect(normalizeToUtcIso('2026-08-29T10:00:00+07:00')).toBe(
      '2026-08-29T03:00:00.000Z',
    );
  });
  it('falls back to now() when absent', () => {
    const now = new Date('2026-08-29T00:00:00.000Z');
    expect(normalizeToUtcIso(undefined, now)).toBe('2026-08-29T00:00:00.000Z');
  });
  it('falls back to now() when unparseable', () => {
    const now = new Date('2026-08-29T00:00:00.000Z');
    expect(normalizeToUtcIso('not-a-date', now)).toBe(
      '2026-08-29T00:00:00.000Z',
    );
  });
});

describe('WebActivityService.filterDormant', () => {
  it('returns [] without querying when the gate is disabled', async () => {
    const query = jest.fn();
    const svc = new WebActivityService(
      { query } as never,
      makeConfig({ WEB_ACTIVITY_GATE_ENABLED: 'false' }),
    );
    expect(await svc.filterDormant([1, 2, 3])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns [] without querying for an empty input', async () => {
    const query = jest.fn();
    const svc = new WebActivityService(
      { query } as never,
      makeConfig({ WEB_ACTIVITY_GATE_ENABLED: 'true' }),
    );
    expect(await svc.filterDormant([])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns the stale userIds when enabled', async () => {
    const query = jest.fn().mockResolvedValue([{ user_id: 2 }]);
    const svc = new WebActivityService(
      { query } as never,
      makeConfig({
        WEB_ACTIVITY_GATE_ENABLED: 'true',
        WEB_ACTIVITY_DORMANT_DAYS: '7',
      }),
    );
    expect(await svc.filterDormant([1, 2])).toEqual([2]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('web_activity'),
      [[1, 2], 7],
    );
  });

  it('fails open on DB error', async () => {
    const query = jest.fn().mockRejectedValue(new Error('conn reset'));
    const svc = new WebActivityService(
      { query } as never,
      makeConfig({ WEB_ACTIVITY_GATE_ENABLED: 'true' }),
    );
    expect(await svc.filterDormant([1])).toEqual([]);
  });

  it('falls back to 7 days on invalid WEB_ACTIVITY_DORMANT_DAYS', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const svc = new WebActivityService(
      { query } as never,
      makeConfig({
        WEB_ACTIVITY_GATE_ENABLED: 'true',
        WEB_ACTIVITY_DORMANT_DAYS: 'abc',
      }),
    );
    await svc.filterDormant([1]);
    expect(query).toHaveBeenCalledWith(expect.any(String), [[1], 7]);
  });
});

describe('WebActivityService.partitionDormant', () => {
  const enabled = makeConfig({ WEB_ACTIVITY_GATE_ENABLED: 'true' });

  it('returns everything unchanged without querying when the gate is disabled', async () => {
    const query = jest.fn();
    const svc = new WebActivityService(
      { query } as never,
      makeConfig({ WEB_ACTIVITY_GATE_ENABLED: 'false' }),
    );
    const items = [{ userId: 1 }, { userId: 2 }];
    expect(await svc.partitionDormant(items, (i) => i.userId)).toEqual({
      active: items,
      suppressed: 0,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('returns everything unchanged without querying for an empty list', async () => {
    const query = jest.fn();
    const svc = new WebActivityService({ query } as never, enabled);
    expect(
      await svc.partitionDormant([], (i: { userId: number }) => i.userId),
    ).toEqual({ active: [], suppressed: 0 });
    expect(query).not.toHaveBeenCalled();
  });

  it('drops the dormant items and counts them', async () => {
    const query = jest.fn().mockResolvedValue([{ user_id: 2 }]);
    const svc = new WebActivityService({ query } as never, enabled);
    const items = [{ userId: 1 }, { userId: 2 }, { userId: 3 }];
    expect(await svc.partitionDormant(items, (i) => i.userId)).toEqual({
      active: [{ userId: 1 }, { userId: 3 }],
      suppressed: 1,
    });
    expect(query).toHaveBeenCalledWith(expect.any(String), [[1, 2, 3], 7]);
  });

  it('keeps items whose userId is null/undefined (never dormant)', async () => {
    const query = jest.fn().mockResolvedValue([{ user_id: 5 }]);
    const svc = new WebActivityService({ query } as never, enabled);
    const items = [{ userId: 5 }, { userId: null }, { userId: undefined }];
    const { active, suppressed } = await svc.partitionDormant(
      items,
      (i) => i.userId,
    );
    expect(active).toEqual([{ userId: null }, { userId: undefined }]);
    expect(suppressed).toBe(1);
    // Only the numeric id is sent to the query.
    expect(query).toHaveBeenCalledWith(expect.any(String), [[5], 7]);
  });

  it('returns everything unchanged when nothing is dormant', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const svc = new WebActivityService({ query } as never, enabled);
    const items = [{ userId: 1 }, { userId: 2 }];
    expect(await svc.partitionDormant(items, (i) => i.userId)).toEqual({
      active: items,
      suppressed: 0,
    });
  });
});

describe('WebActivityService.recordActive', () => {
  // The whole merge contract the acceptance criteria name — first insert,
  // later-timestamp update, stale/duplicate no-op — is carried by this one
  // statement: INSERT ... ON CONFLICT DO UPDATE with a GREATEST(existing, new)
  // merge and a LEAST(new, now()) future-clamp. Behaviour is exercised end to
  // end by database:migration-compatibility against real Postgres; here we pin
  // the statement that produces it.
  const EXPECTED_SQL =
    'INSERT INTO web_activity (user_id, last_active_at, updated_at) ' +
    'VALUES ($1, LEAST($2::timestamptz, now()), now()) ' +
    'ON CONFLICT (user_id) DO UPDATE ' +
    'SET last_active_at = GREATEST(web_activity.last_active_at, LEAST($2::timestamptz, now())), ' +
    'updated_at = now()';

  function callSql(mock: jest.Mock): string {
    return String(mock.mock.calls[0][0]).replace(/\s+/g, ' ').trim();
  }

  it('emits the GREATEST/LEAST upsert and writes regardless of gate state', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const svc = new WebActivityService(
      { query } as never,
      makeConfig({ WEB_ACTIVITY_GATE_ENABLED: 'false' }),
    );
    await svc.recordActive(42, '2026-08-29T10:00:00Z');
    expect(callSql(query)).toBe(EXPECTED_SQL);
    expect(query.mock.calls[0][1]).toEqual([42, '2026-08-29T10:00:00.000Z']);
  });

  it('normalises an offset-less timestamp to UTC before binding', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const svc = new WebActivityService(
      { query } as never,
      makeConfig({ WEB_ACTIVITY_GATE_ENABLED: 'true' }),
    );
    await svc.recordActive(7, '2026-08-29T10:00:00');
    expect(query.mock.calls[0][1]).toEqual([7, '2026-08-29T10:00:00.000Z']);
  });

  it('defaults a missing timestamp to now() (bound value close to current time)', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const svc = new WebActivityService(
      { query } as never,
      makeConfig({ WEB_ACTIVITY_GATE_ENABLED: 'true' }),
    );
    const before = Date.now();
    await svc.recordActive(7);
    const bound = Date.parse(query.mock.calls[0][1][1]);
    expect(bound).toBeGreaterThanOrEqual(before - 1000);
    expect(bound).toBeLessThanOrEqual(Date.now() + 1000);
  });
});
