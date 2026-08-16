import { Logger } from '@nestjs/common';
import { errorMessage } from '@wispace/bot-common';
import { buildLearnerProfileSection } from './learner-profile-section';
import type { LearnerProfileStorePort } from './learner-profile.store.port';
import type { LearnerIdentity } from './types';

/** Minimal shape of the agent input the suffix builder needs. */
export interface LearnerProfileSuffixInput extends LearnerIdentity {
  /** When the learner is not linked, the profile is still usable for greeting context. */
  userId?: number;
}

export interface LearnerProfileSuffixOptions {
  /** Freshness window per fact (default: 24h). */
  ttlMs?: number;
  /** Fired when loading the profile fails — defaults to a warn log. */
  onError?: (error: unknown, identity: LearnerIdentity) => void;
}

/**
 * Builds the `systemPromptSuffix` appending the learner-profile section to
 * the chat prompt. Returns undefined when there is nothing fresh to say —
 * the caller can then keep its own suffix only.
 */
export function createLearnerProfileSuffix(
  store: LearnerProfileStorePort,
  platform: string,
  options: LearnerProfileSuffixOptions = {},
): (input: LearnerProfileSuffixInput) => Promise<string | undefined> {
  const logger = new Logger('LearnerProfile');
  const onError =
    options.onError ??
    ((error: unknown) => {
      logger.warn(`failed to load learner profile: ${errorMessage(error)}`);
    });

  return async (
    input: LearnerProfileSuffixInput,
  ): Promise<string | undefined> => {
    try {
      const profile = await store.get(platform, input.externalUserId);
      return buildLearnerProfileSection(profile, new Date(), options.ttlMs);
    } catch (error) {
      onError(error, input);
      return undefined;
    }
  };
}
