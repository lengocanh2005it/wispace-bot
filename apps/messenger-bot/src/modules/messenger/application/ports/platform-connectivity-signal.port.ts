/**
 * Health signals the outbound path reports back to platform connectivity
 * (#1088). The concrete tracker lives in infrastructure; this port keeps the
 * application service free of that import.
 */
export interface PlatformConnectivitySignalPort {
  markTokenRejected(): void;
  markOutboundSuccess(): void;
}

export const PLATFORM_CONNECTIVITY_SIGNAL = Symbol(
  'PLATFORM_CONNECTIVITY_SIGNAL',
);
