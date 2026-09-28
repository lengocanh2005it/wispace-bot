import {
  buildClarificationCancelledMessage,
  buildClarificationMessage,
  buildClarificationUnavailableMessage,
  buildStopAcknowledgedMessage,
  buildWispaceScopeRedirectMessage,
  isAmbiguousMessage,
  isObviouslyOffTopic,
  isStopIntent,
} from '@wispace/llm-agent/core';
import {
  ClarificationCore,
  type ClarificationDecision,
  type ClarificationEvent,
  type ClarificationTerminalDecisionKind,
} from './clarification-core';
import {
  clarificationStateKey,
  type ClarificationLimits,
  type ClarificationState,
  type ClarificationStateStore,
} from './clarification-state';
import {
  isCancel,
  isContradictory,
  parseChoice,
  type ClarificationChoice,
  type ClarificationIrrelevantAction,
} from './clarification-text';

const VERSION_CONFLICT = 'Clarification state version conflict';

/**
 * Every outcome label the clarification decision vocabulary can record: each
 * terminal rule's own list, plus the two reasons an unusable state is dropped,
 * which are recorded outside the table because `stale_state` is intermediate.
 * `delivery_failure` is recorded at the chat-queue delivery-failure site and is
 * not part of this vocabulary, so it is deliberately absent.
 */
export const CLARIFICATION_OUTCOMES = [
  'blocked_tool',
  'replayed',
  'stale_reply',
  'expired',
  'identity_reset',
  'choice',
  'cancelled',
  'stop_acknowledged',
  'new_question',
  'max_reset',
  'reset_menu',
  'irrelevant_clarify',
  'started_offtopic',
  'started_ambiguous',
  'unavailable',
  'skip_delivery',
] as const;

export type ClarificationOutcome = (typeof CLARIFICATION_OUTCOMES)[number];

/** The terminal kinds an `recordIrrelevant` action can select. */
export type ClarificationIrrelevantTerminalKind =
  | 'irrelevant_clarify'
  | 'reset_menu'
  | 'max_reset';

/**
 * Two of the core's three `recordIrrelevant` action names do not match the
 * terminal kind they select, so the join is stated here instead of assumed.
 * Exhaustive in both directions: a new action or a new kind breaks the build.
 */
export const CLARIFICATION_IRRELEVANT_ACTION_KINDS: Readonly<
  Record<ClarificationIrrelevantAction, ClarificationIrrelevantTerminalKind>
> = {
  clarify: 'irrelevant_clarify',
  reset_menu: 'reset_menu',
  clear: 'max_reset',
};

/** What a reply builder may read about the turn it is answering. */
export interface ClarificationReplyContext {
  decision: ClarificationDecision;
  request: ClarificationRequest;
  /** Server-derived: whether the message was outside the WISPACE scope. */
  offTopic: boolean;
}

export type ClarificationReplyBuilder = (
  context: ClarificationReplyContext,
) => string | Promise<string>;

export interface ClarificationTerminalRule {
  /**
   * Every outcome counted for this decision, in the order the branch counted
   * them. A list because four branches count two: their own label plus
   * `blocked_tool`, and the two suppressions carry `skip_delivery` so the
   * "counted but not sent" pairing is one list rather than two decisions.
   */
  readonly outcomes: readonly ClarificationOutcome[];
  /** True when the reply is suppressed rather than sent. */
  readonly skipDelivery: boolean;
  /**
   * The reply text. Absent for the two kinds that hand the turn back to the
   * pipeline instead of answering. Async because the cancel and stop
   * acknowledgements resolve a pending reschedule cancellation first.
   */
  readonly reply?: ClarificationReplyBuilder;
}

const identityStopReply = (fallback: string): string => fallback;

const menuTextFor = (offTopic: boolean): string =>
  offTopic ? buildWispaceScopeRedirectMessage() : buildClarificationMessage();

const menuOrRedirect = ({ offTopic }: ClarificationReplyContext): string =>
  menuTextFor(offTopic);

function cachedReplyOf(decision: ClarificationDecision): string | undefined {
  return decision.kind === 'replayed' || decision.kind === 'stale_reply'
    ? decision.replyText
    : undefined;
}

/**
 * The one place a terminal decision becomes telemetry, reply text, and a
 * skip-or-deliver flag. `Record` over the closed union makes a missing entry a
 * compile error, and every entry carries all three together so "counted but not
 * sent" cannot be applied half-way.
 */
export const CLARIFICATION_TERMINAL_RULES: Readonly<
  Record<ClarificationTerminalDecisionKind, ClarificationTerminalRule>
> = {
  replayed: {
    outcomes: ['replayed', 'skip_delivery'],
    skipDelivery: true,
    reply: ({ decision }) =>
      cachedReplyOf(decision) ?? buildClarificationMessage(),
  },
  stale_reply: {
    outcomes: ['stale_reply', 'skip_delivery'],
    skipDelivery: true,
    reply: ({ decision }) =>
      cachedReplyOf(decision) ?? buildClarificationMessage(),
  },
  cancelled: {
    outcomes: ['cancelled'],
    skipDelivery: false,
    // #959: the same words double as a stop request outside menu context — the
    // acknowledgement covers both honestly.
    reply: ({ request }) =>
      (request.resolveStopReply ?? identityStopReply)(
        isStopIntent(request.userText)
          ? buildStopAcknowledgedMessage()
          : buildClarificationCancelledMessage(),
      ),
  },
  choice: {
    outcomes: ['choice'],
    skipDelivery: false,
  },
  // The version-gated consume lost its race: the learner is shown the menu
  // again and the turn is delivered, so this is not the `replayed` suppression.
  consume_race_lost: {
    outcomes: ['blocked_tool', 'replayed'],
    skipDelivery: false,
    reply: () => buildClarificationMessage(),
  },
  stop_acknowledged: {
    outcomes: ['stop_acknowledged'],
    skipDelivery: false,
    reply: ({ request }) =>
      (request.resolveStopReply ?? identityStopReply)(
        buildStopAcknowledgedMessage(),
      ),
  },
  new_question: {
    outcomes: ['new_question'],
    skipDelivery: false,
  },
  max_reset: {
    outcomes: ['blocked_tool', 'max_reset'],
    skipDelivery: false,
    reply: () => buildClarificationMessage(),
  },
  irrelevant_clarify: {
    outcomes: ['irrelevant_clarify', 'blocked_tool'],
    skipDelivery: false,
    reply: menuOrRedirect,
  },
  reset_menu: {
    outcomes: ['reset_menu', 'blocked_tool'],
    skipDelivery: false,
    reply: menuOrRedirect,
  },
  started_offtopic: {
    outcomes: ['started_offtopic', 'blocked_tool'],
    skipDelivery: false,
    reply: menuOrRedirect,
  },
  started_ambiguous: {
    outcomes: ['started_ambiguous', 'blocked_tool'],
    skipDelivery: false,
    reply: menuOrRedirect,
  },
  unavailable: {
    outcomes: ['unavailable', 'blocked_tool'],
    skipDelivery: false,
    reply: () => buildClarificationUnavailableMessage(),
  },
};

export interface ClarificationRequest {
  externalUserId: string;
  userText: string;
  /** The account the stored state must belong to. */
  userId?: number;
  /** Stable inbound-event key: the replay and tombstone identity. */
  eventId?: string;
  /**
   * Orchestration-supplied: cancels a pending reschedule and resolves the stop
   * or cancel acknowledgement. Absent means "no pending reschedule".
   */
  resolveStopReply?: (fallback: string) => string | Promise<string>;
}

export type ClarificationTurn =
  | {
      readonly kind: 'reply';
      readonly text: string;
      readonly skipDelivery: boolean;
    }
  | { readonly kind: 'continue'; readonly choice?: ClarificationChoice };

/** The raw store failure, handed up so the caller can log it masked. */
export interface ClarificationStoreFailure {
  externalUserId: string;
  eventId?: string;
  error: unknown;
}

export interface ClarificationResponderOptions {
  platform: string;
  store: ClarificationStateStore;
  limits?: ClarificationLimits;
  /** Records one clarification outcome. Never changes the turn. */
  outcomeInc?: (outcome: ClarificationOutcome) => void;
  /**
   * A store that throws still has to produce the unavailable reply, the
   * degraded-mode event, and a masked log line, so the raw failure is handed
   * out rather than swallowed.
   */
  onStoreUnavailable?: (failure: ClarificationStoreFailure) => void;
  now?: () => number;
}

/**
 * Owns the store, keeps the version number internal, and turns a stored state
 * plus an incoming event into a decision, a write, and one turn. A caller that
 * holds a `ClarificationTurn` cannot read or write a state field, and nothing
 * here returns a version.
 */
export class ClarificationResponder {
  private readonly core: ClarificationCore;
  private readonly now: () => number;

  constructor(private readonly options: ClarificationResponderOptions) {
    this.core = new ClarificationCore(options.limits);
    this.now = options.now ?? Date.now;
  }

  /** One clarification turn for one inbound event. */
  async handle(request: ClarificationRequest): Promise<ClarificationTurn> {
    return this.attempt(request, true);
  }

  /**
   * `retryOnVersionConflict` is private on purpose: one attempt plus one
   * bounded re-read is the compare-and-set contract, not a caller choice.
   */
  private async attempt(
    request: ClarificationRequest,
    retryOnVersionConflict: boolean,
  ): Promise<ClarificationTurn> {
    const { externalUserId, userText } = request;
    const key = clarificationStateKey(this.options.platform, externalUserId);
    const now = this.now();
    const event: ClarificationEvent = {
      ...(request.eventId === undefined ? {} : { eventId: request.eventId }),
      ...(request.userId === undefined ? {} : { userId: request.userId }),
    };

    try {
      let state = await this.options.store.get(key);
      let inspection = this.core.inspect(state, event, now);

      if (inspection.kind === 'stale_state') {
        this.record(inspection.reason);
        await this.clearGated(key, state!);
        state = null;
        inspection = this.core.inspect(state, event, now);
      }

      if (inspection.kind === 'replayed') {
        return this.terminal(inspection, 'replayed', request, false);
      }

      if (inspection.kind === 'stale_reply') {
        return this.terminal(inspection, 'stale_reply', request, false);
      }

      if (inspection.kind === 'consumed') {
        const cleared = await this.options.store.clear(key, state!.version);
        if (cleared === false) {
          // One bounded retry, never a loop: contention behaviour is unchanged.
          if (retryOnVersionConflict) return this.attempt(request, false);
          throw new Error(VERSION_CONFLICT);
        }
        state = null;
        if (inspection.choice) {
          return this.terminal(inspection, 'choice', request, false);
        }
      }

      if (isCancel(userText)) {
        const cancelled = await this.options.store.clear(key, state?.version);
        if (state && cancelled === false) throw new Error(VERSION_CONFLICT);
        return this.terminal(
          { kind: 'cancelled' },
          'cancelled',
          request,
          false,
        );
      }

      const choice = state ? parseChoice(userText) : null;
      if (state && choice) {
        const consumed = await this.options.store.set(
          key,
          this.core.consume(state, event, now, choice),
          state.version,
        );
        if (consumed === false) {
          return this.terminal(
            { kind: 'consume_race_lost' },
            'consume_race_lost',
            request,
            false,
          );
        }
        return this.terminal(
          { kind: 'choice', choice },
          'choice',
          request,
          false,
        );
      }

      const offTopic = isObviouslyOffTopic(userText);
      const stop = isStopIntent(userText);
      const ambiguous =
        isAmbiguousMessage(userText) || isContradictory(userText);

      // #959: a stop request is a clear intent — clear any pending menu and
      // answer honestly instead of re-showing the clarification menu.
      if (stop) {
        if (state) await this.clearGated(key, state);
        return this.terminal(
          { kind: 'stop_acknowledged' },
          'stop_acknowledged',
          request,
          offTopic,
        );
      }

      if (state && !offTopic && !ambiguous) {
        // Retain a tombstone so delayed choices from the superseded menu cannot
        // execute tools after this new question reaches the agent.
        const superseded = await this.options.store.set(
          key,
          this.core.consume(state, event, now),
          state.version,
        );
        if (superseded === false) throw new Error(VERSION_CONFLICT);
        return this.terminal(
          { kind: 'new_question' },
          'new_question',
          request,
          offTopic,
        );
      }

      const menuText = menuTextFor(offTopic);

      if (state) {
        const next = this.core.recordIrrelevant(state, event, now, menuText);
        const kind = CLARIFICATION_IRRELEVANT_ACTION_KINDS[next.action];
        if (next.action === 'clear') {
          await this.clearGated(key, state);
          return this.terminal({ kind }, kind, request, offTopic);
        }
        const updated = await this.options.store.set(
          key,
          next.state!,
          state.version,
        );
        if (updated === false) {
          return await this.replayAfterConflict(key, request, offTopic);
        }
        return this.terminal({ kind }, kind, request, offTopic);
      }

      if (offTopic || ambiguous) {
        const started = await this.options.store.set(
          key,
          this.core.begin(event, now, menuText),
          0,
        );
        if (started === false) {
          return await this.replayAfterConflict(key, request, offTopic);
        }
        const kind = offTopic ? 'started_offtopic' : 'started_ambiguous';
        return this.terminal({ kind }, kind, request, offTopic);
      }

      return { kind: 'continue' };
    } catch (error) {
      // Telemetry must never cost the learner the fail-closed reply.
      try {
        this.options.onStoreUnavailable?.({
          externalUserId,
          ...(request.eventId === undefined
            ? {}
            : { eventId: request.eventId }),
          error,
        });
      } catch {
        // ignored on purpose
      }
      return this.terminal(
        { kind: 'unavailable' },
        'unavailable',
        request,
        false,
      );
    }
  }

  /**
   * Marks a definitive outbound failure so the state stays retryable. The
   * identity fence: no state for this event means no write.
   */
  async markDeliveryFailed(
    externalUserId: string,
    eventId?: string,
  ): Promise<void> {
    if (!eventId) return;
    const key = clarificationStateKey(this.options.platform, externalUserId);
    const state = await this.options.store.get(key);
    const failed = this.core.failDelivery(state, { eventId });
    if (!failed) return;
    await this.options.store.set(key, failed, state!.version);
  }

  private async terminal(
    decision: ClarificationDecision,
    kind: ClarificationTerminalDecisionKind,
    request: ClarificationRequest,
    offTopic: boolean,
  ): Promise<ClarificationTurn> {
    const rule = CLARIFICATION_TERMINAL_RULES[kind];
    for (const outcome of rule.outcomes) this.record(outcome);
    const builder = rule.reply;
    if (!builder) {
      const choice = decision.kind === 'choice' ? decision.choice : undefined;
      return choice ? { kind: 'continue', choice } : { kind: 'continue' };
    }
    return {
      kind: 'reply',
      text: await builder({ decision, request, offTopic }),
      skipDelivery: rule.skipDelivery,
    };
  }

  /** A write that lost its race re-reads once; a replay is suppressed, anything else conflicts. */
  private async replayAfterConflict(
    key: string,
    request: ClarificationRequest,
    offTopic: boolean,
  ): Promise<ClarificationTurn> {
    const replay = await this.options.store.get(key);
    if (
      replay &&
      replay.lastEventId === request.eventId &&
      replay.lastReplyText
    ) {
      return this.terminal(
        { kind: 'replayed', replyText: replay.lastReplyText },
        'replayed',
        request,
        offTopic,
      );
    }
    throw new Error(VERSION_CONFLICT);
  }

  private async clearGated(
    key: string,
    state: ClarificationState,
  ): Promise<void> {
    const cleared = await this.options.store.clear(key, state.version);
    if (cleared === false) throw new Error(VERSION_CONFLICT);
  }

  private record(outcome: ClarificationOutcome): void {
    try {
      this.options.outcomeInc?.(outcome);
    } catch {
      // Metrics must never change chat behavior.
    }
  }
}
