import type { WispaceIdHeader } from '../utils/wispace-headers';
import type { WispaceClientMetrics } from '../clients/wispace-client-types';

export type WispaceLinkStatus = 'active' | 'revoked';

export type WispaceLinkStatusResult =
  | {
      kind: 'active';
      userId: number;
      ownershipVersion?: string;
    }
  | {
      kind: 'revoked';
      reason: string;
      ownershipVersion?: string;
    }
  | {
      kind: 'unknown';
      reason: string;
    };

export interface WispaceLinkStatusClientConfig {
  url?: string;
  internalKey?: string;
  header: WispaceIdHeader;
  requestTimeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  enabled?: boolean;
  /** Keep-alive connections per host (#567). Default: 6. */
  poolSize?: number;
  metrics?: WispaceClientMetrics;
}
