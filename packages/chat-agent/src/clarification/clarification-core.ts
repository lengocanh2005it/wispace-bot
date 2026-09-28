import {
  DEFAULT_CLARIFICATION_LIMITS,
  MAX_CLARIFICATION_EVENT_HISTORY,
  isClarificationStateExpired,
  normalizeLimits,
  type ClarificationIrrelevantResult,
  type ClarificationLimits,
  type ClarificationState,
} from './clarification-state';
import type { ClarificationChoice } from './clarification-text';

/** The inbound event a state is classified against. */
export interface ClarificationEvent {
  /** Stable inbound-event key: the replay and tombstone identity. */
  eventId?: string;
  /** The account the stored state must belong to. */
  userId?: number;
}

/** Why a stored state cannot answer for the incoming event. */
export type ClarificationStaleReason = 'expired' | 'identity_reset';

/**
 * The closed decision vocabulary. Thirteen terminal kinds — the turn ends on
 * one of them, and each maps to exactly one reply — and three intermediate
 * kinds, which clear or open the state and then let the caller carry on.
 */
export type ClarificationDecision =
  | { kind: 'replayed'; replyText?: string }
  | { kind: 'stale_reply'; replyText?: string }
  | { kind: 'cancelled' }
  | { kind: 'choice'; choice: ClarificationChoice }
  | { kind: 'consume_race_lost' }
  | { kind: 'stop_acknowledged' }
  | { kind: 'new_question' }
  | { kind: 'max_reset' }
  | { kind: 'irrelevant_clarify' }
  | { kind: 'reset_menu' }
  | { kind: 'started_offtopic' }
  | { kind: 'started_ambiguous' }
  | { kind: 'unavailable' }
  | { kind: 'stale_state'; reason: ClarificationStaleReason }
  | { kind: 'consumed'; choice?: ClarificationChoice }
  | { kind: 'proceed' };

/**
 * Terminal kinds: the turn ends here. The responder adds `consume_race_lost`
 * — a decision made about a write, not a classification of a state — so it is
 * declared here and returned by the responder rather than by `inspect`.
 */
export const CLARIFICATION_TERMINAL_DECISION_KINDS = [
  'replayed',
  'stale_reply',
  'cancelled',
  'choice',
  'consume_race_lost',
  'stop_acknowledged',
  'new_question',
  'max_reset',
  'irrelevant_clarify',
  'reset_menu',
  'started_offtopic',
  'started_ambiguous',
  'unavailable',
] as const satisfies ReadonlyArray<ClarificationDecision['kind']>;

/** The terminal subset of the decision vocabulary, keyed on by the reply table. */
export type ClarificationTerminalDecisionKind =
  (typeof CLARIFICATION_TERMINAL_DECISION_KINDS)[number];

/** Intermediate kinds: clear or open the state, then keep going. */
export const CLARIFICATION_INTERMEDIATE_DECISION_KINDS: ReadonlyArray<
  ClarificationDecision['kind']
> = ['stale_state', 'consumed', 'proceed'];

/** What `inspect` can return: a suppression, the stale state, the consumed state, or proceed. */
export type ClarificationInspection = Extract<
  ClarificationDecision,
  { kind: 'replayed' | 'stale_reply' | 'stale_state' | 'consumed' | 'proceed' }
>;

function appendEventIdentity(
  recentEventIds: string[] | undefined,
  eventId: string | undefined,
): string[] | undefined {
  return eventId
    ? [...(recentEventIds ?? []), eventId].slice(
        -MAX_CLARIFICATION_EVENT_HISTORY,
      )
    : recentEventIds;
}

function withReply(
  state: ClarificationState,
  eventId: string | undefined,
  replyText: string,
): ClarificationState {
  const recentEventIds = appendEventIdentity(state.recentEventIds, eventId);
  return {
    ...state,
    ...(eventId ? { lastEventId: eventId } : {}),
    ...(recentEventIds ? { recentEventIds } : {}),
    lastReplyText: replyText,
    lastDeliveryFailed: false,
  };
}

/**
 * The pure clarification core: a state and a clock value in, a state or a
 * decision out. It never sees a store, a clock, or a framework, and it does
 * not keep the version to itself — the responder that owns the store does.
 */
export class ClarificationCore {
  private readonly limits: ClarificationLimits;

  constructor(limits: ClarificationLimits = DEFAULT_CLARIFICATION_LIMITS) {
    this.limits = normalizeLimits(limits);
  }

  /** A fresh state at version one, carrying the event identity and canned reply. */
  begin(
    event: ClarificationEvent,
    now: number,
    replyText: string,
  ): ClarificationState {
    const recentEventIds = appendEventIdentity(undefined, event.eventId);
    return {
      phase: 'awaiting_choice',
      attempts: 0,
      menuResets: 0,
      version: 1,
      createdAt: now,
      expiresAt: now + this.limits.ttlMs,
      ...(event.userId === undefined ? {} : { userId: event.userId }),
      ...(event.eventId ? { lastEventId: event.eventId } : {}),
      ...(recentEventIds ? { recentEventIds } : {}),
      lastReplyText: replyText,
      lastDeliveryFailed: false,
    };
  }

  /**
   * Bumps the attempt or menu-reset counter, refreshes the expiry, and attaches
   * the event identity and the new canned reply in one step. The action alone
   * means the state must be cleared.
   */
  recordIrrelevant(
    state: ClarificationState,
    event: ClarificationEvent,
    now: number,
    replyText: string,
  ): ClarificationIrrelevantResult {
    const { eventId } = event;
    if (state.attempts < this.limits.maxAttempts) {
      return {
        action: 'clarify',
        state: withReply(
          {
            ...state,
            attempts: state.attempts + 1,
            version: state.version + 1,
            expiresAt: now + this.limits.ttlMs,
          },
          eventId,
          replyText,
        ),
      };
    }

    if (state.menuResets < this.limits.maxMenuResets) {
      return {
        action: 'reset_menu',
        state: withReply(
          {
            ...state,
            attempts: 0,
            menuResets: state.menuResets + 1,
            version: state.version + 1,
            expiresAt: now + this.limits.ttlMs,
          },
          eventId,
          replyText,
        ),
      };
    }

    return { action: 'clear' };
  }

  /** Accepts a choice, moves to the consumed phase, and extends the tombstone. */
  consume(
    state: ClarificationState,
    event: ClarificationEvent,
    now: number,
    choice?: ClarificationChoice,
  ): ClarificationState {
    const { eventId } = event;
    const recentEventIds = appendEventIdentity(state.recentEventIds, eventId);
    return {
      ...state,
      phase: 'consumed',
      version: state.version + 1,
      expiresAt: now + this.limits.ttlMs,
      ...(eventId ? { lastEventId: eventId } : {}),
      ...(recentEventIds ? { recentEventIds } : {}),
      ...(choice ? { lastChoice: choice } : {}),
    };
  }

  /**
   * Marks a definitive outbound failure so the state stays retryable. Yields
   * nothing when the state is not for that event: the identity fence.
   */
  failDelivery(
    state: ClarificationState | null,
    event: ClarificationEvent,
  ): ClarificationState | undefined {
    if (!state || state.lastEventId !== event.eventId) return undefined;
    return { ...state, version: state.version + 1, lastDeliveryFailed: true };
  }

  /**
   * Classifies a state against an incoming event. A `stale_state` or a
   * `consumed` decision means the state is cleared; a `consumed` decision
   * carries the previously accepted choice only when the delivery for that
   * same event failed, so a new message is never swallowed by a tombstone.
   */
  inspect(
    state: ClarificationState | null,
    event: ClarificationEvent,
    now: number,
  ): ClarificationInspection {
    if (!state) return { kind: 'proceed' };
    if (isClarificationStateExpired(state, now)) {
      return { kind: 'stale_state', reason: 'expired' };
    }
    if (state.userId !== event.userId) {
      return { kind: 'stale_state', reason: 'identity_reset' };
    }
    if (
      event.eventId &&
      state.lastEventId === event.eventId &&
      state.lastDeliveryFailed !== true &&
      (state.lastReplyText || state.phase === 'consumed')
    ) {
      return { kind: 'replayed', replyText: state.lastReplyText };
    }
    if (
      event.eventId &&
      state.lastEventId !== event.eventId &&
      state.recentEventIds?.includes(event.eventId)
    ) {
      return { kind: 'stale_reply', replyText: state.lastReplyText };
    }
    if (state.phase === 'consumed') {
      return {
        kind: 'consumed',
        choice:
          state.lastDeliveryFailed === true &&
          event.eventId === state.lastEventId
            ? state.lastChoice
            : undefined,
      };
    }
    return { kind: 'proceed' };
  }

  /** The single expiry rule, shared with the store's prune pass. */
  isExpired(state: ClarificationState, now: number): boolean {
    return isClarificationStateExpired(state, now);
  }
}
