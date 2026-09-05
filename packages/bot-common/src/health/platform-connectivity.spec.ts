import {
  PlatformConnectivityState,
  createUnavailablePlatformSnapshot,
} from './platform-connectivity';

describe('PlatformConnectivityState', () => {
  it('publishes the initial state and serialized transitions', () => {
    const transitions: Array<{ status: string; ready: boolean }> = [];
    const state = new PlatformConnectivityState('discord', ({ current }) => {
      transitions.push({ status: current.status, ready: current.ready });
    });

    expect(state.getSnapshot()).toMatchObject({
      name: 'discord',
      status: 'starting',
      ready: false,
      reason: 'startup_pending',
    });
    state.transition({
      status: 'connected',
      ready: true,
      reason: 'connected',
      lastConnectedAt: '2026-09-05T00:00:00.000Z',
      lastVerifiedAt: '2026-09-05T00:00:00.000Z',
    });
    expect(transitions).toEqual([
      { status: 'starting', ready: false },
      { status: 'connected', ready: true },
    ]);
  });

  it('marks shutdown and ignores later transitions after destruction', () => {
    const state = new PlatformConnectivityState('zalo');
    state.onModuleDestroy();
    expect(state.getSnapshot()).toMatchObject({
      status: 'unavailable',
      ready: false,
      reason: 'shutdown',
    });
    state.transition({
      status: 'connected',
      ready: true,
      reason: 'connected',
      lastConnectedAt: null,
      lastVerifiedAt: null,
    });
    expect(state.getSnapshot().status).toBe('unavailable');
  });

  it('creates a safe missing-state snapshot', () => {
    expect(createUnavailablePlatformSnapshot()).toEqual({
      name: 'unknown',
      status: 'unavailable',
      ready: false,
      reason: 'platform_state_missing',
      lastConnectedAt: null,
      lastVerifiedAt: null,
    });
  });
});
