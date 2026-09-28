/**
 * The organic-welcome capability zalo-chat needs from zalo-oauth.
 *
 * Narrow by design: chat only asks "welcome this follower if one is due" and
 * never sees the claim/lease/dedupe policy behind the answer. zalo-oauth keeps
 * ownership of the delivery and of its own outcome vocabulary.
 */
export type ZaloWelcomeOutcome = 'sent' | 'skipped' | 'error';

export interface ZaloWelcomePort {
  organicWelcomeIfDue(
    zaloUserId: string,
    message: string,
  ): Promise<ZaloWelcomeOutcome>;
}

export const ZALO_WELCOME = Symbol('ZALO_WELCOME');
