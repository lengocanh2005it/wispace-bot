import { EventEmitter } from 'events';
import type { ConfigService } from '@nestjs/config';
import { PlatformConnectivityState } from '@wispace/bot-common/health';
import { DiscordPlatformConnectivityService } from './discord-platform-connectivity.service';

function buildConfig(graceMs = '60000'): ConfigService {
  return {
    get: (key: string) =>
      key === 'DISCORD_READINESS_RECONNECT_GRACE_MS' ? graceMs : undefined,
  } as unknown as ConfigService;
}

describe('DiscordPlatformConnectivityService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('requires the first gateway ready event before readiness succeeds', () => {
    const client = new EventEmitter();
    const state = new PlatformConnectivityState('discord');
    const service = new DiscordPlatformConnectivityService(
      client as never,
      buildConfig(),
      state,
    );

    service.onModuleInit();
    expect(state.getSnapshot().ready).toBe(false);
    client.emit('clientReady');
    expect(state.getSnapshot()).toMatchObject({
      status: 'connected',
      ready: true,
      reason: 'connected',
    });
    service.onModuleDestroy();
  });

  it('keeps readiness during reconnect grace and fails after the deadline', () => {
    jest.useFakeTimers();
    const client = new EventEmitter();
    const state = new PlatformConnectivityState('discord');
    const service = new DiscordPlatformConnectivityService(
      client as never,
      buildConfig('1000'),
      state,
    );

    service.onModuleInit();
    client.emit('clientReady');
    client.emit('shardReconnecting');
    expect(state.getSnapshot()).toMatchObject({
      status: 'reconnecting',
      ready: true,
      reason: 'reconnect_grace',
    });
    jest.advanceTimersByTime(1000);
    expect(state.getSnapshot()).toMatchObject({
      status: 'reconnecting',
      ready: false,
      reason: 'reconnect_timeout',
    });
    service.onModuleDestroy();
  });

  it('fails immediately on an invalidated gateway session', () => {
    const client = new EventEmitter();
    const state = new PlatformConnectivityState('discord');
    const service = new DiscordPlatformConnectivityService(
      client as never,
      buildConfig(),
      state,
    );

    service.onModuleInit();
    client.emit('clientReady');
    client.emit('invalidated');
    expect(state.getSnapshot()).toMatchObject({
      status: 'session_invalid',
      ready: false,
      reason: 'gateway_invalidated',
    });
    service.onModuleDestroy();
  });
});
