import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'discord.js';
import { PlatformConnectivityState } from '@wispace/bot-common/health';

const DEFAULT_RECONNECT_GRACE_MS = 60_000;

@Injectable()
export class DiscordPlatformConnectivityService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(DiscordPlatformConnectivityService.name);
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly reconnectGraceMs: number;

  constructor(
    private readonly client: Client,
    private readonly configService: ConfigService,
    private readonly state: PlatformConnectivityState,
  ) {
    const configured = Number(
      configService.get<string>('DISCORD_READINESS_RECONNECT_GRACE_MS'),
    );
    this.reconnectGraceMs =
      Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_RECONNECT_GRACE_MS;
  }

  onModuleInit(): void {
    this.client.once('clientReady', this.handleReady);
    this.client.on('shardReady', this.handleReady);
    this.client.on('shardResume', this.handleReady);
    this.client.on('shardReconnecting', this.handleReconnectStart);
    this.client.on('shardDisconnect', this.handleReconnectStart);
    this.client.on('shardError', this.handleReconnectStart);
    this.client.on('error', this.handleReconnectStart);
    this.client.on('invalidated', this.handleInvalidated);
  }

  onModuleDestroy(): void {
    this.clearReconnectTimer();
    this.client.removeListener('clientReady', this.handleReady);
    this.client.removeListener('shardReady', this.handleReady);
    this.client.removeListener('shardResume', this.handleReady);
    this.client.removeListener('shardReconnecting', this.handleReconnectStart);
    this.client.removeListener('shardDisconnect', this.handleReconnectStart);
    this.client.removeListener('shardError', this.handleReconnectStart);
    this.client.removeListener('error', this.handleReconnectStart);
    this.client.removeListener('invalidated', this.handleInvalidated);
  }

  private readonly handleReady = (): void => {
    this.clearReconnectTimer();
    const now = new Date().toISOString();
    this.state.transition({
      status: 'connected',
      ready: true,
      reason: 'connected',
      lastConnectedAt: now,
      lastVerifiedAt: now,
    });
    this.logger.log('Discord gateway connectivity is ready');
  };

  private readonly handleReconnectStart = (): void => {
    const previous = this.state.getSnapshot();
    if (!previous.lastConnectedAt) {
      this.state.transition({
        status: 'starting',
        ready: false,
        reason: 'startup_pending',
        lastConnectedAt: null,
        lastVerifiedAt: previous.lastVerifiedAt,
      });
      return;
    }

    this.clearReconnectTimer();
    this.state.transition({
      status: 'reconnecting',
      ready: true,
      reason: 'reconnect_grace',
      lastConnectedAt: previous.lastConnectedAt,
      lastVerifiedAt: previous.lastVerifiedAt,
    });
    this.reconnectTimer = setTimeout(() => {
      const current = this.state.getSnapshot();
      if (current.status !== 'reconnecting') return;
      this.state.transition({
        status: 'reconnecting',
        ready: false,
        reason: 'reconnect_timeout',
        lastConnectedAt: current.lastConnectedAt,
        lastVerifiedAt: current.lastVerifiedAt,
      });
    }, this.reconnectGraceMs);
    this.reconnectTimer.unref?.();
  };

  private readonly handleInvalidated = (): void => {
    this.clearReconnectTimer();
    const current = this.state.getSnapshot();
    this.state.transition({
      status: 'session_invalid',
      ready: false,
      reason: 'gateway_invalidated',
      lastConnectedAt: current.lastConnectedAt,
      lastVerifiedAt: current.lastVerifiedAt,
    });
    this.logger.error('Discord gateway session was invalidated');
  };

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }
}
