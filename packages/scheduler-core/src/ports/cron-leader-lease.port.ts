/** Lease-based leader election — implemented per app with a DB store. */
export interface CronLeaderLeasePort {
  /** Claims the lease if free/expired/owned by this instance. */
  claim(name: string, instanceId: string): Promise<boolean>;
  /** Refreshes the lease if it is still owned by this instance. */
  heartbeat(name: string, instanceId: string): Promise<void>;
}
