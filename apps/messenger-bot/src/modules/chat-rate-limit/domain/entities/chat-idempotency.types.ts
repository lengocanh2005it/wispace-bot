/**
 * The Messenger port's own input shape, not a copy of the core's.
 *
 * `ReserveFreeFormSlotInput` names the field `psid` where the shared core
 * names it `externalUserId`, and the persistence adapter translates between
 * them. That translation is the point of the boundary: collapsing the two
 * would push one platform's vocabulary into the core that all three platforms
 * share.
 *
 * The outcome types were pure duplicates of the core's, with no field to
 * translate, so they are imported from it instead.
 */
export interface ReserveFreeFormSlotInput {
  psid: string;
  userId?: number;
  usageDate: string;
  idempotencyKey: string;
  /** H3: hard cap inside the same transaction as idempotency insert. */
  dailyLimit: number;
  burstLimit?: number;
  burstSince?: Date;
  burstCountsRefunded?: boolean;
}
