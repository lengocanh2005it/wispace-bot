import type { RescheduleAttemptStorePort } from '@wispace/reschedule-confirm/core';

/**
 * The reschedule attempt record zalo-chat needs in order to report how a
 * confirmation was delivered.
 *
 * The record is owned by `reschedule-confirm`; chat only reads a delivery
 * outcome into it. Bound behind a token so the concrete TypeORM adapter stays
 * in the composition root, which is what the layering rule requires.
 */
export type ZaloRescheduleAttemptStorePort = RescheduleAttemptStorePort;

export const ZALO_RESCHEDULE_ATTEMPT_STORE = Symbol(
  'ZALO_RESCHEDULE_ATTEMPT_STORE',
);
