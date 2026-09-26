import type { MessengerMappingRepositoryPort } from './messenger-mapping.repository.port';
import type { MessengerMessageLogRepositoryPort } from './messenger-message-log.repository.port';

export const MESSENGER_REPOSITORY = Symbol('MESSENGER_REPOSITORY');

export type { ReportClaimRepositoryPort } from '@wispace/scheduler-core/core';

/**
 * Full repository port — extends the focused ports for backward compatibility.
 * New consumers should import the focused ports directly.
 */
export interface MessengerRepositoryPort
  extends MessengerMappingRepositoryPort, MessengerMessageLogRepositoryPort {}
