import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlatformConnectivityState } from '@wispace/bot-common/health';
import { keepAliveFetch } from '@messenger/shared/http/http-agent';

const DEFAULT_CHECK_INTERVAL_MS = 300_000;
const DEFAULT_STALE_MS = 300_000;

@Injectable()
export class MessengerPlatformConnectivityService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(
    MessengerPlatformConnectivityService.name,
  );
  private readonly checkIntervalMs: number;
  private readonly staleMs: number;
  private interval: ReturnType<typeof setInterval> | undefined;
  private staleTimer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly state: PlatformConnectivityState,
  ) {
    this.checkIntervalMs = this.readPositiveNumber(
      'MESSENGER_PLATFORM_HEALTH_CHECK_INTERVAL_MS',
      DEFAULT_CHECK_INTERVAL_MS,
    );
    this.staleMs = this.readPositiveNumber(
      'MESSENGER_PLATFORM_HEALTH_STALE_MS',
      DEFAULT_STALE_MS,
    );
  }

  onModuleInit(): void {
    if (this.configService.get<string>('NODE_ENV') === 'test') return;
    this.state.transition({
      status: 'starting',
      ready: false,
      reason: 'meta_validation_pending',
      lastConnectedAt: null,
      lastVerifiedAt: null,
    });
    void this.validate();
    this.interval = setInterval(
      () => void this.validate(),
      this.checkIntervalMs,
    );
    this.interval.unref?.();
  }

  onModuleDestroy(): void {
    if (this.interval) clearInterval(this.interval);
    if (this.staleTimer) clearTimeout(this.staleTimer);
  }

  markTokenRejected(): void {
    const current = this.state.getSnapshot();
    this.state.transition({
      status: 'credential_invalid',
      ready: false,
      reason: 'meta_token_rejected',
      lastConnectedAt: current.lastConnectedAt,
      lastVerifiedAt: current.lastVerifiedAt,
    });
  }

  markOutboundSuccess(): void {
    this.markSuccess();
  }

  private async validate(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const token = this.configService.get<string>('PAGE_ACCESS_TOKEN')?.trim();
      if (!token) {
        this.transitionFailure('token_missing', true);
        return;
      }

      const version =
        this.configService.get<string>('GRAPH_API_VERSION')?.trim() ?? 'v21.0';
      const response = await keepAliveFetch(
        `https://graph.facebook.com/${version}/me?fields=id`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
          timeoutMs: 10_000,
        },
      );
      if (response.ok) {
        this.markSuccess();
        return;
      }

      if (response.status >= 400 && response.status < 500) {
        this.markTokenRejected();
        return;
      }
      this.transitionFailure('meta_validation_failed');
    } catch (error) {
      this.logger.warn(
        `Messenger platform validation failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.transitionFailure('meta_validation_failed');
    } finally {
      this.inFlight = false;
    }
  }

  private markSuccess(): void {
    const now = new Date().toISOString();
    this.clearStaleTimer();
    this.state.transition({
      status: 'connected',
      ready: true,
      reason: 'connected',
      lastConnectedAt: now,
      lastVerifiedAt: now,
    });
    this.staleTimer = setTimeout(() => {
      const current = this.state.getSnapshot();
      const lastVerifiedAt = current.lastVerifiedAt
        ? Date.parse(current.lastVerifiedAt)
        : NaN;
      if (
        !Number.isFinite(lastVerifiedAt) ||
        Date.now() - lastVerifiedAt < this.staleMs
      ) {
        return;
      }
      if (current.status !== 'connected' && current.ready === false) return;
      this.state.transition({
        status: 'reconnecting',
        ready: false,
        reason: 'meta_validation_failed',
        lastConnectedAt: current.lastConnectedAt,
        lastVerifiedAt: current.lastVerifiedAt,
      });
    }, this.staleMs);
    this.staleTimer.unref?.();
  }

  private transitionFailure(
    reason: 'meta_validation_failed' | 'token_missing',
    forceUnavailable = false,
  ): void {
    const current = this.state.getSnapshot();
    const lastVerifiedAt = current.lastVerifiedAt
      ? Date.parse(current.lastVerifiedAt)
      : NaN;
    const withinStale =
      !forceUnavailable &&
      Number.isFinite(lastVerifiedAt) &&
      Date.now() - lastVerifiedAt < this.staleMs;
    this.state.transition({
      status: withinStale ? 'reconnecting' : 'unavailable',
      ready: withinStale,
      reason: withinStale ? 'reconnect_grace' : reason,
      lastConnectedAt: current.lastConnectedAt,
      lastVerifiedAt: current.lastVerifiedAt,
    });
  }

  private clearStaleTimer(): void {
    if (!this.staleTimer) return;
    clearTimeout(this.staleTimer);
    this.staleTimer = undefined;
  }

  private readPositiveNumber(key: string, fallback: number): number {
    const value = Number(this.configService.get<string>(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }
}
