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

describe('WebActivityService.recordActive', () => {
  it('upserts with GREATEST + LEAST clamp regardless of gate state', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const svc = new WebActivityService(
      { query } as never,
      makeConfig({ WEB_ACTIVITY_GATE_ENABLED: 'false' }),
    );
    await svc.recordActive(42, '2026-08-29T10:00:00Z');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (user_id) DO UPDATE');
    expect(sql).toContain('GREATEST');
    expect(sql).toContain('LEAST($2::timestamptz, now())');
    expect(params).toEqual([42, '2026-08-29T10:00:00.000Z']);
  });
});
