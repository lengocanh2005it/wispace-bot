import { Injectable, OnModuleDestroy } from '@nestjs/common';

export type PlatformConnectivityName =
  | 'messenger'
  | 'discord'
  | 'zalo'
  | 'unknown';

export type PlatformConnectivityStatus =
  | 'starting'
  | 'connected'
  | 'reconnecting'
  | 'credential_invalid'
  | 'session_invalid'
  | 'unavailable';

export type PlatformConnectivityReason =
  | 'startup_pending'
  | 'connected'
  | 'reconnect_grace'
  | 'reconnect_timeout'
  | 'gateway_invalidated'
  | 'token_missing'
  | 'token_refresh_failed'
  | 'token_refresh_rejected'
  | 'meta_validation_pending'
  | 'meta_validation_failed'
  | 'meta_token_rejected'
  | 'shutdown'
  | 'platform_state_missing';

export interface PlatformConnectivitySnapshot {
  name: PlatformConnectivityName;
  status: PlatformConnectivityStatus;
  ready: boolean;
  reason: PlatformConnectivityReason;
  lastConnectedAt: string | null;
  lastVerifiedAt: string | null;
}

export interface PlatformConnectivityPort {
  getSnapshot(): PlatformConnectivitySnapshot;
}

export const PLATFORM_CONNECTIVITY = Symbol('PLATFORM_CONNECTIVITY');

export function createUnavailablePlatformSnapshot(
  name: PlatformConnectivityName = 'unknown',
  reason: PlatformConnectivityReason = 'platform_state_missing',
): PlatformConnectivitySnapshot {
  return {
    name,
    status: 'unavailable',
    ready: false,
    reason,
    lastConnectedAt: null,
    lastVerifiedAt: null,
  };
}

export interface PlatformConnectivityTransition {
  previous: PlatformConnectivitySnapshot;
  current: PlatformConnectivitySnapshot;
}

export type PlatformConnectivityTransitionListener = (
  transition: PlatformConnectivityTransition,
) => void;

/**
 * Small in-process state holder for platform lifecycle adapters. It keeps the
 * health probe synchronous and gives every adapter one serialized transition
 * boundary for race-safe state publication.
 */
@Injectable()
export class PlatformConnectivityState
  implements PlatformConnectivityPort, OnModuleDestroy
{
  private snapshot: PlatformConnectivitySnapshot;
  private destroyed = false;

  constructor(
    name: PlatformConnectivityName,
    private readonly onTransition?: PlatformConnectivityTransitionListener,
  ) {
    this.snapshot = {
      name,
      status: 'starting',
      ready: false,
      reason: 'startup_pending',
      lastConnectedAt: null,
      lastVerifiedAt: null,
    };
    this.onTransition?.({
      previous: { ...this.snapshot },
      current: { ...this.snapshot },
    });
  }

  getSnapshot(): PlatformConnectivitySnapshot {
    return { ...this.snapshot };
  }

  transition(
    next: Omit<PlatformConnectivitySnapshot, 'name'> & {
      name?: PlatformConnectivityName;
    },
  ): void {
    if (this.destroyed) return;
    const previous = this.snapshot;
    this.snapshot = {
      ...next,
      name: next.name ?? previous.name,
    };
    this.onTransition?.({
      previous: { ...previous },
      current: { ...this.snapshot },
    });
  }

  markShutdown(): void {
    if (
      this.snapshot.status === 'unavailable' &&
      this.snapshot.reason === 'shutdown'
    ) {
      return;
    }
    this.transition({
      status: 'unavailable',
      ready: false,
      reason: 'shutdown',
      lastConnectedAt: this.snapshot.lastConnectedAt,
      lastVerifiedAt: this.snapshot.lastVerifiedAt,
    });
  }

  onModuleDestroy(): void {
    this.markShutdown();
    this.destroyed = true;
  }
}
