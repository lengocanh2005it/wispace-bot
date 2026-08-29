import type { DataSource } from 'typeorm';
import { PlatformLinkStateService } from './platform-link-state.service';

describe('PlatformLinkStateService', () => {
  it('returns a locally-unlinked tombstone when the mapping row was erased', async () => {
    const dataSource = {
      query: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            mappingGeneration: '8',
            createdAt: new Date('2026-08-29T01:00:00Z'),
          },
        ]),
    } as unknown as DataSource;
    const service = new PlatformLinkStateService(dataSource);

    await expect(service.getLink('messenger', 'psid-1')).resolves.toMatchObject(
      {
        state: 'locally-unlinked',
        generation: '8',
      },
    );
  });

  it('revokes atomically, bumps generation, cancels work, and writes redacted audit', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          id: '9',
          platform: 'discord',
          externalUserId: 'discord-user-1',
          userId: 42,
          state: 'active',
          generation: '3',
          ownershipVersion: null,
          lastVerifiedAt: null,
          revokedAt: null,
        },
      ])
      .mockResolvedValue([]);
    const dataSource = {
      transaction: jest.fn(
        (fn: (manager: { query: typeof query }) => unknown) => fn({ query }),
      ),
    } as unknown as DataSource;
    const service = new PlatformLinkStateService(dataSource);

    const result = await service.applyObservation('discord', 'discord-user-1', {
      kind: 'revoked',
      reason: 'Bearer super-secret\u0000 upstream_unlinked',
    });

    expect(result).toEqual({ outcome: 'revoked', generation: '4', userId: 42 });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("link_state = 'confirmed-revoked'"),
      ['9', 'discord', '4', 'Bearer [REDACTED] upstream_unlinked', null],
    );
    const auditCall = query.mock.calls.at(-1);
    expect(auditCall?.[0]).toContain('platform_link_audit_events');
    expect(auditCall?.[1]?.[1]).toMatch(/^[a-f0-9]{64}$/);
    expect(auditCall?.[1]?.[1]).not.toBe('discord-user-1');
    expect(auditCall?.[1]?.[4]).toContain('Bearer [REDACTED]');
    expect(auditCall?.[1]?.[4]).not.toContain('\u0000');
  });

  it('does not resurrect a confirmed-revoked row from a stale active observation', async () => {
    const query = jest.fn().mockResolvedValueOnce([
      {
        id: '9',
        platform: 'discord',
        externalUserId: 'discord-user-1',
        userId: 42,
        state: 'confirmed-revoked',
        generation: '4',
        ownershipVersion: null,
        lastVerifiedAt: null,
        revokedAt: new Date(),
      },
    ]);
    const dataSource = {
      transaction: jest.fn(
        (fn: (manager: { query: typeof query }) => unknown) => fn({ query }),
      ),
    } as unknown as DataSource;
    const service = new PlatformLinkStateService(dataSource);

    await expect(
      service.applyObservation('discord', 'discord-user-1', {
        kind: 'active',
        userId: 42,
      }),
    ).resolves.toEqual({
      outcome: 'stale_writer',
      generation: '4',
      userId: 42,
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain('platform_link_audit_events');
  });

  it('does not reactivate a locally-unlinked row from status polling', async () => {
    const query = jest.fn().mockResolvedValueOnce([
      {
        id: '9',
        platform: 'discord',
        externalUserId: 'discord-user-1',
        userId: 42,
        state: 'locally-unlinked',
        generation: '4',
        ownershipVersion: null,
        lastVerifiedAt: null,
        revokedAt: new Date(),
      },
    ]);
    const dataSource = {
      transaction: jest.fn(
        (fn: (manager: { query: typeof query }) => unknown) => fn({ query }),
      ),
    } as unknown as DataSource;
    const service = new PlatformLinkStateService(dataSource);

    await expect(
      service.applyObservation('discord', 'discord-user-1', {
        kind: 'active',
        userId: 42,
      }),
    ).resolves.toEqual({
      outcome: 'locally_unlinked',
      generation: '4',
      userId: 42,
      changed: false,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects an observation fetched before a relink generation change', async () => {
    const query = jest.fn().mockResolvedValueOnce([
      {
        id: '9',
        platform: 'discord',
        externalUserId: 'discord-user-1',
        userId: 77,
        state: 'active',
        generation: '5',
        ownershipVersion: 'new',
        lastVerifiedAt: null,
        revokedAt: null,
      },
    ]);
    const dataSource = {
      transaction: jest.fn(
        (fn: (manager: { query: typeof query }) => unknown) => fn({ query }),
      ),
    } as unknown as DataSource;
    const service = new PlatformLinkStateService(dataSource);

    await expect(
      service.applyObservation(
        'discord',
        'discord-user-1',
        { kind: 'revoked', reason: 'old-response' },
        { expectedGeneration: '4' },
      ),
    ).resolves.toMatchObject({ outcome: 'stale_writer', generation: '5' });
  });

  it('marks transiently unknown mappings unusable without destroying queued work', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          id: '9',
          platform: 'zalo',
          externalUserId: 'zalo-user-1',
          userId: 42,
          state: 'active',
          generation: '1',
          ownershipVersion: null,
          lastVerifiedAt: null,
          revokedAt: null,
        },
      ])
      .mockResolvedValue([]);
    const dataSource = {
      transaction: jest.fn(
        (fn: (manager: { query: typeof query }) => unknown) => fn({ query }),
      ),
    } as unknown as DataSource;
    const service = new PlatformLinkStateService(dataSource);

    await expect(
      service.applyObservation('zalo', 'zalo-user-1', {
        kind: 'unknown',
        reason: 'upstream_timeout',
      }),
    ).resolves.toMatchObject({ outcome: 'unknown', generation: '1' });
    expect(
      query.mock.calls.some((call) => call[0]?.includes('study_reminder_jobs')),
    ).toBe(false);
  });

  it('reports persistent unknown state on every reconcile tick', async () => {
    const listQuery = jest
      .fn()
      .mockResolvedValueOnce([
        {
          id: '9',
          platform: 'discord',
          externalUserId: 'discord-user-1',
          userId: 42,
          state: 'temporarily-unknown',
          generation: '3',
          ownershipVersion: null,
          lastVerifiedAt: null,
          revokedAt: null,
        },
      ])
      .mockResolvedValueOnce([]);
    const txQuery = jest.fn().mockResolvedValue([
      {
        id: '9',
        platform: 'discord',
        externalUserId: 'discord-user-1',
        userId: 42,
        state: 'temporarily-unknown',
        generation: '3',
        ownershipVersion: null,
        lastVerifiedAt: null,
        revokedAt: null,
      },
    ]);
    const dataSource = {
      query: listQuery,
      transaction: jest.fn(
        (fn: (manager: { query: typeof txQuery }) => unknown) =>
          fn({ query: txQuery }),
      ),
    } as unknown as DataSource;
    const service = new PlatformLinkStateService(dataSource);
    const onUnknown = jest.fn().mockResolvedValue(undefined);

    const result = await service.reconcile(
      'discord',
      {
        enabled: true,
        getStatus: jest.fn().mockResolvedValue({
          kind: 'unknown',
          reason: 'upstream_unavailable',
        }),
      },
      { onUnknown, pageSize: 10 },
    );

    expect(result.unknown).toBe(1);
    expect(onUnknown).toHaveBeenCalledWith('discord-user-1', 42);
  });

  it('reconciles a page with bounded concurrency', async () => {
    const rows = Array.from({ length: 4 }, (_, index) => ({
      id: String(index + 1),
      platform: 'zalo',
      externalUserId: `zalo-${index + 1}`,
      userId: index + 1,
      state: 'active',
      generation: '1',
      ownershipVersion: null,
      lastVerifiedAt: null,
      revokedAt: null,
    }));
    const listQuery = jest
      .fn()
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([]);
    const txQuery = jest.fn().mockResolvedValue(rows.slice(0, 1));
    const dataSource = {
      query: listQuery,
      transaction: jest.fn(
        (fn: (manager: { query: typeof txQuery }) => unknown) =>
          fn({ query: txQuery }),
      ),
    } as unknown as DataSource;
    const service = new PlatformLinkStateService(dataSource);
    let active = 0;
    let maxActive = 0;

    await service.reconcile('zalo', {
      enabled: true,
      getStatus: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return { kind: 'active', userId: 1 };
      },
    });

    expect(maxActive).toBeGreaterThan(1);
  });
});
