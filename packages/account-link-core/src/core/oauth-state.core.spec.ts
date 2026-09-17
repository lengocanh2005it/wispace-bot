import { OAuthStateCore, type OAuthStateStore } from './oauth-state.core';

describe('OAuthStateCore', () => {
  it('generates a single-use state, cleans bounded expired rows, and enforces TTL', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const rows = new Map<string, { payload: string; createdAt: Date }>();
    const cleanup = jest.fn();
    const store: OAuthStateStore<string> = {
      save: async (state, payload, createdAt) => {
        rows.set(state, { payload, createdAt });
      },
      consume: async (state) => {
        const row = rows.get(state);
        rows.delete(state);
        return row;
      },
      cleanupExpired: async (before, limit) => cleanup(before, limit),
    };
    const core = new OAuthStateCore(store, {
      now: () => now,
      generateState: () => 'state-1',
      ttlMs: 1_000,
    });

    await expect(core.create('payload')).resolves.toBe('state-1');
    expect(cleanup).toHaveBeenCalledWith(
      new Date('2025-12-31T23:59:59.000Z'),
      100,
    );
    await expect(core.consume('state-1')).resolves.toBe('payload');
    await expect(core.consume('state-1')).resolves.toBeUndefined();

    await core.create('expired');
    now = new Date('2026-01-01T00:00:01.001Z');
    await expect(core.consume('state-1')).resolves.toBeUndefined();
  });

  it('rejects state timestamps more than 60 seconds in the future', async () => {
    const store: OAuthStateStore<string> = {
      save: async () => undefined,
      consume: async () => ({
        payload: 'payload',
        createdAt: new Date('2026-01-01T00:01:00.001Z'),
      }),
      cleanupExpired: async () => undefined,
    };
    const core = new OAuthStateCore(store, {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    await expect(core.consume('future-state')).resolves.toBeUndefined();
  });

  it('accepts the exact 60-second future-skew boundary', async () => {
    const store: OAuthStateStore<string> = {
      save: async () => undefined,
      consume: async () => ({
        payload: 'payload',
        createdAt: new Date('2026-01-01T00:01:00.000Z'),
      }),
      cleanupExpired: async () => undefined,
    };
    const core = new OAuthStateCore(store, {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    await expect(core.consume('future-state')).resolves.toBe('payload');
  });
});
