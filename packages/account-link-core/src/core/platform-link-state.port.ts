import type { Platform, PlatformLinkState } from '@wispace/contracts';

export const PLATFORM_LINK_STATE = Symbol('PLATFORM_LINK_STATE');

/** Ownership snapshot a reconcile workflow reads before re-committing. */
export interface PlatformLinkSnapshot {
  state: PlatformLinkState;
  generation?: string;
  revokedAt?: Date;
}

export type PlatformLinkStatusObservation =
  | { kind: 'active'; userId: number; ownershipVersion?: string }
  | { kind: 'revoked'; reason: string; ownershipVersion?: string }
  | { kind: 'unknown'; reason: string };

export interface PlatformLinkStatusReader {
  readonly enabled: boolean;
  getStatus(externalUserId: string): Promise<PlatformLinkStatusObservation>;
}

export interface PlatformLinkReconcileTotals {
  checked: number;
  revoked: number;
  unknown: number;
  recovered: number;
  staleWriter: number;
}

export interface PlatformLinkReconcileOptions {
  onRevoked?: (externalUserId: string, userId?: number) => Promise<void>;
  onUnknown?: (externalUserId: string, userId?: number) => Promise<void>;
}

/**
 * Ownership read/reconcile seam. @wispace/database owns the TypeORM
 * implementation; application workflows depend on this contract only.
 */
export interface PlatformLinkStatePort {
  getLink(
    platform: Platform,
    externalUserId: string,
  ): Promise<PlatformLinkSnapshot | null>;
  reconcile(
    platform: Platform,
    reader: PlatformLinkStatusReader,
    options?: PlatformLinkReconcileOptions,
  ): Promise<PlatformLinkReconcileTotals>;
}
