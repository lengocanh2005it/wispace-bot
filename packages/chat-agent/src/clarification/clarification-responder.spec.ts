import { CLARIFICATION_TERMINAL_DECISION_KINDS } from './clarification-core';
import {
  DEFAULT_CLARIFICATION_LIMITS,
  clarificationStateKey,
  type ClarificationState,
  type ClarificationStateStore,
} from './clarification-state';
import type { ClarificationIrrelevantAction } from './clarification-text';
import {
  CLARIFICATION_IRRELEVANT_ACTION_KINDS,
  CLARIFICATION_OUTCOMES,
  CLARIFICATION_TERMINAL_RULES,
  ClarificationResponder,
  type ClarificationOutcome,
  type ClarificationRequest,
  type ClarificationStoreFailure,
} from './clarification-responder';

const NOW = 1_700_000_000_000;

function buildStore(seed?: ClarificationState): {
  store: ClarificationStateStore;
  outcomes: ClarificationOutcome[];
  failures: ClarificationStoreFailure[];
  responder: ClarificationResponder;
  send: (request: Partial<ClarificationRequest>) => Promise<void>;
} {
  const states = new Map<string, ClarificationState>();
  if (seed) states.set('discord:u1', seed);
  const outcomes: ClarificationOutcome[] = [];
  const failures: ClarificationStoreFailure[] = [];
  const store: ClarificationStateStore = {
    get: jest.fn(async (key: string) => states.get(key) ?? null),
    set: jest.fn(async (key, next, expectedVersion) => {
      const currentVersion = states.get(key)?.version ?? 0;
      if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
        return false;
      }
      states.set(key, next);
      return true;
    }),
    clear: jest.fn(async (key, expectedVersion) => {
      const current = states.get(key);
      if (
        expectedVersion !== undefined &&
        (!current || current.version !== expectedVersion)
      ) {
        return false;
      }
      states.delete(key);
      return true;
    }),
  };
  const responder = new ClarificationResponder({
    platform: 'discord',
    store,
    outcomeInc: (outcome) => outcomes.push(outcome),
    onStoreUnavailable: (failure) => failures.push(failure),
    now: () => NOW,
  });
  const request: ClarificationRequest = {
    externalUserId: 'u1',
    userText: 'tiến độ của tôi thế nào',
    eventId: 'event-a',
    userId: 7,
  };
  return {
    store,
    outcomes,
    failures,
    responder,
    send: async (partial) => {
      await responder.handle({ ...request, ...partial });
    },
  };
}

const menuState = (overrides: Partial<ClarificationState> = {}) => ({
  phase: 'awaiting_choice' as const,
  attempts: 0,
  menuResets: 0,
  version: 2,
  createdAt: NOW - 1_000,
  expiresAt: NOW + 600_000,
  userId: 7,
  lastEventId: 'menu-event',
  recentEventIds: ['menu-event'],
  lastReplyText: 'menu-text',
  lastDeliveryFailed: false,
  ...overrides,
});

describe('clarification terminal rule table', () => {
  it('gives every terminal kind exactly one rule', () => {
    expect(Object.keys(CLARIFICATION_TERMINAL_RULES).sort()).toEqual(
      [...CLARIFICATION_TERMINAL_DECISION_KINDS].sort(),
    );
  });

  it('keeps the skip flag and the skip_delivery outcome in the same entry', () => {
    for (const kind of CLARIFICATION_TERMINAL_DECISION_KINDS) {
      const rule = CLARIFICATION_TERMINAL_RULES[kind];
      expect(rule.outcomes.includes('skip_delivery')).toBe(rule.skipDelivery);
      expect(rule.reply === undefined).toBe(
        kind === 'choice' || kind === 'new_question',
      );
    }

    // Only the two replay suppressions drop the learner's message.
    expect(
      CLARIFICATION_TERMINAL_DECISION_KINDS.filter(
        (kind) => CLARIFICATION_TERMINAL_RULES[kind].skipDelivery,
      ),
    ).toEqual(['replayed', 'stale_reply']);
  });

  it('joins every core action to a terminal kind without assuming identity', () => {
    expect(CLARIFICATION_IRRELEVANT_ACTION_KINDS).toEqual({
      clarify: 'irrelevant_clarify',
      reset_menu: 'reset_menu',
      clear: 'max_reset',
    });

    const actions: ClarificationIrrelevantAction[] = [
      'clarify',
      'reset_menu',
      'clear',
    ];
    expect(Object.keys(CLARIFICATION_IRRELEVANT_ACTION_KINDS).sort()).toEqual(
      [...actions].sort(),
    );
  });

  it('names exactly the outcomes the vocabulary records, plus the two stale reasons', () => {
    const declared = new Set<string>([
      ...CLARIFICATION_TERMINAL_DECISION_KINDS.flatMap(
        (kind) => CLARIFICATION_TERMINAL_RULES[kind].outcomes,
      ),
      'expired',
      'identity_reset',
    ]);

    expect([...declared].sort()).toEqual([...CLARIFICATION_OUTCOMES].sort());
  });
});

describe('ClarificationResponder', () => {
  it('answers a menu choice with the accepted intent and tombstones the state', async () => {
    const { responder, store, outcomes } = buildStore(menuState());

    const turn = await responder.handle({
      externalUserId: 'u1',
      userText: '2',
      eventId: 'event-a',
      userId: 7,
    });

    expect(turn).toEqual({ kind: 'continue', choice: 'schedule' });
    expect(outcomes).toEqual(['choice']);
    expect(store.set).toHaveBeenCalledWith(
      'discord:u1',
      expect.objectContaining({ phase: 'consumed', lastChoice: 'schedule' }),
      2,
    );
  });

  it('gives the menu back when the version-gated consume loses its race', async () => {
    const { responder, store, outcomes } = buildStore(menuState());
    jest
      .mocked(store.set)
      .mockResolvedValueOnce(false as unknown as boolean & void);

    const turn = await responder.handle({
      externalUserId: 'u1',
      userText: '1',
      eventId: 'event-a',
      userId: 7,
    });

    expect(turn).toEqual({
      kind: 'reply',
      text: expect.stringContaining('Tiến độ'),
      skipDelivery: false,
    });
    expect(outcomes).toEqual(['blocked_tool', 'replayed']);
  });

  it('suppresses a replayed event with the cached reply text', async () => {
    const { responder, outcomes } = buildStore(
      menuState({ lastEventId: 'event-a' }),
    );

    const turn = await responder.handle({
      externalUserId: 'u1',
      userText: 'tiến độ của tôi thế nào',
      eventId: 'event-a',
      userId: 7,
    });

    expect(turn).toEqual({
      kind: 'reply',
      text: 'menu-text',
      skipDelivery: true,
    });
    expect(outcomes).toEqual(['replayed', 'skip_delivery']);
  });

  it('suppresses an out-of-order event from the tombstone window', async () => {
    const { responder, outcomes } = buildStore(
      menuState({
        recentEventIds: ['menu-event', 'old-event'],
        lastEventId: 'menu-event',
      }),
    );

    const turn = await responder.handle({
      externalUserId: 'u1',
      userText: 'tiến độ của tôi thế nào',
      eventId: 'old-event',
      userId: 7,
    });

    expect(turn).toEqual({
      kind: 'reply',
      text: 'menu-text',
      skipDelivery: true,
    });
    expect(outcomes).toEqual(['stale_reply', 'skip_delivery']);
  });

  it('records why an unusable state was dropped and asks afresh', async () => {
    const expired = buildStore(menuState({ expiresAt: NOW - 1 }));
    await expired.send({ userText: 'abc???' });

    expect(expired.outcomes).toEqual([
      'expired',
      'started_ambiguous',
      'blocked_tool',
    ]);
    expect(expired.store.get).toHaveBeenCalledWith('discord:u1');

    const wrongAccount = buildStore(menuState({ userId: 99 }));
    await wrongAccount.send({ userText: 'abc???' });

    expect(wrongAccount.outcomes).toEqual([
      'identity_reset',
      'started_ambiguous',
      'blocked_tool',
    ]);
  });

  it('reopens a consumed state only for the event whose delivery failed', async () => {
    const failed = buildStore(
      menuState({
        phase: 'consumed',
        lastEventId: 'event-a',
        lastChoice: 'progress',
        lastDeliveryFailed: true,
      }),
    );

    const turn = await failed.responder.handle({
      externalUserId: 'u1',
      userText: 'tiến độ của tôi thế nào',
      eventId: 'event-a',
      userId: 7,
    });
    expect(failed.outcomes).toEqual(['choice']);
    // The accepted choice has to survive the redelivery — it is the rewritten
    // input the pipeline sends on (#1143, regression: it was dropped here).
    expect(turn).toEqual({ kind: 'continue', choice: 'progress' });

    const swallowed = buildStore(
      menuState({
        phase: 'consumed',
        lastEventId: 'other-event',
        recentEventIds: ['other-event'],
        lastChoice: 'progress',
      }),
    );

    await swallowed.send({ userText: 'tiến độ của tôi thế nào' });
    expect(swallowed.outcomes).toEqual([]);
    expect(swallowed.store.clear).toHaveBeenCalledWith('discord:u1', 2);
  });

  it('retries a consumed clear exactly once, then fails closed', async () => {
    const { responder, store, outcomes, failures } = buildStore(
      menuState({ phase: 'consumed', lastEventId: 'other-event' }),
    );
    jest
      .mocked(store.clear)
      .mockResolvedValue(false as unknown as boolean & void);

    const turn = await responder.handle({
      externalUserId: 'u1',
      userText: 'tiến độ của tôi thế nào',
      eventId: 'event-a',
      userId: 7,
    });

    expect(store.clear).toHaveBeenCalledTimes(2);
    expect(outcomes).toEqual(['unavailable', 'blocked_tool']);
    expect(failures[0].error).toBeInstanceOf(Error);
    expect((failures[0].error as Error).message).toBe(
      'Clarification state version conflict',
    );
    expect(turn.kind).toBe('reply');
  });

  it('cancels a pending menu and acknowledges through the reschedule port', async () => {
    const responder = new ClarificationResponder({
      platform: 'discord',
      store: buildStore(menuState()).store,
      now: () => NOW,
    });

    const turn = await responder.handle({
      externalUserId: 'u1',
      userText: 'bỏ qua',
      eventId: 'event-a',
      userId: 7,
      resolveStopReply: async () => 'đã hủy lịch',
    });

    expect(turn).toEqual({
      kind: 'reply',
      text: 'đã hủy lịch',
      skipDelivery: false,
    });
  });

  it('answers a stop request honestly instead of re-showing the menu', async () => {
    const { responder, store, outcomes } = buildStore(menuState());

    const turn = await responder.handle({
      externalUserId: 'u1',
      userText: 'dừng lại',
      eventId: 'event-a',
      userId: 7,
    });

    expect(turn.kind).toBe('reply');
    expect(turn.kind === 'reply' && turn.text).toContain('dừng');
    expect(store.clear).toHaveBeenCalledWith('discord:u1', 2);
    expect(outcomes).toEqual(['stop_acknowledged']);
  });

  it('tombstones a pending menu so a clear new question cannot be answered by it', async () => {
    const { responder, store, outcomes } = buildStore(menuState());

    const turn = await responder.handle({
      externalUserId: 'u1',
      userText: 'Xem tiến độ học của mình',
      eventId: 'event-a',
      userId: 7,
    });

    expect(store.set).toHaveBeenCalledWith(
      'discord:u1',
      expect.objectContaining({ phase: 'consumed' }),
      2,
    );
    expect(turn).toEqual({ kind: 'continue' });
    expect(outcomes).toEqual(['new_question']);
  });

  it('counts a bounded irrelevant follow-up and a reset before clearing', async () => {
    const first = buildStore(menuState({ attempts: 0, menuResets: 0 }));
    await first.send({ userText: 'abc???' });
    expect(first.outcomes).toEqual(['irrelevant_clarify', 'blocked_tool']);

    const last = buildStore(menuState({ attempts: 2, menuResets: 1 }));
    await last.send({ userText: 'abc???' });
    expect(last.outcomes).toEqual(['blocked_tool', 'max_reset']);
    expect(last.store.clear).toHaveBeenCalledWith('discord:u1', 2);
  });

  // #1143 review: the max_reset path used to record its two outcomes and *then*
  // attempt the version-gated clear, so a clear that lost its race fell into
  // the fail-closed catch and counted four outcomes. The clear now runs first,
  // which is the order every other write follows, so the conflict counts two.
  // Reply text, skip flag and store effect are unchanged; only the counters are.
  it('records only the fail-closed pair when the max_reset clear loses its race', async () => {
    const { responder, store, outcomes, failures } = buildStore(
      menuState({ attempts: 2, menuResets: 1 }),
    );
    jest
      .mocked(store.clear)
      .mockResolvedValue(false as unknown as boolean & void);

    const turn = await responder.handle({
      externalUserId: 'u1',
      userText: 'abc???',
      eventId: 'event-a',
      userId: 7,
    });

    expect(outcomes).toEqual(['unavailable', 'blocked_tool']);
    expect(outcomes).not.toContain('max_reset');
    expect(failures[0].error).toBeInstanceOf(Error);
    expect((failures[0].error as Error).message).toBe(
      'Clarification state version conflict',
    );
    expect(turn.kind === 'reply' && turn.text).toContain('chưa thể');
    expect(turn.kind === 'reply' && turn.skipDelivery).toBe(false);
  });

  // #1143 review: the post-conflict re-read used to re-state the replay rule
  // inline, and a weaker version of it. Both write paths now ask the core, so
  // this pins the one rule they share — a same-event cached reply is suppressed,
  // anything else is a conflict.
  it.each([
    [
      'a different account',
      menuState({
        lastEventId: 'event-a',
        lastReplyText: 'concurrent-menu',
        userId: 99,
      }),
    ],
    [
      'a state that already failed delivery',
      menuState({
        lastEventId: 'event-a',
        lastReplyText: 'concurrent-menu',
        lastDeliveryFailed: true,
      }),
    ],
    [
      'an expired state',
      menuState({
        lastEventId: 'event-a',
        lastReplyText: 'concurrent-menu',
        expiresAt: NOW - 1,
      }),
    ],
  ])('fails closed when a lost write re-reads %s', async (_case, reRead) => {
    const { responder, store, outcomes } = buildStore();
    jest
      .mocked(store.set)
      .mockResolvedValueOnce(false as unknown as boolean & void);
    // The first read finds nothing, so the set is what loses its race; the
    // re-read inside the conflict handler is what returns this state.
    jest
      .mocked(store.get)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(reRead);

    const turn = await responder.handle({
      externalUserId: 'u1',
      userText: 'abc???',
      eventId: 'event-a',
      userId: 7,
    });

    expect(store.get).toHaveBeenCalledTimes(2);
    expect(outcomes).toEqual(['unavailable', 'blocked_tool']);
    expect(turn.kind === 'reply' && turn.skipDelivery).toBe(false);
  });

  it('opens a fresh state for an off-topic message', async () => {
    const { responder, store, outcomes } = buildStore();

    const turn = await responder.handle({
      externalUserId: 'u1',
      userText: 'thời tiết hôm nay thế nào',
      eventId: 'event-a',
      userId: 7,
    });

    expect(turn.kind).toBe('reply');
    expect(store.set).toHaveBeenCalledWith(
      'discord:u1',
      expect.objectContaining({ version: 1, userId: 7 }),
      0,
    );
    expect(outcomes).toEqual(['started_offtopic', 'blocked_tool']);
  });

  it('fails closed when a write loses its race and the re-read is not a replay', async () => {
    const { responder, store, outcomes } = buildStore();
    jest
      .mocked(store.set)
      .mockResolvedValue(false as unknown as boolean & void);

    const turn = await responder.handle({
      externalUserId: 'u1',
      userText: 'abc???',
      eventId: 'event-a',
      userId: 7,
    });

    expect(store.get).toHaveBeenCalledTimes(2);
    expect(outcomes).toEqual(['unavailable', 'blocked_tool']);
    expect(turn.kind).toBe('reply');
  });

  it('suppresses a write that lost its race to a concurrent copy of the same event', async () => {
    const { responder, store, outcomes } = buildStore();
    jest
      .mocked(store.set)
      .mockResolvedValueOnce(false as unknown as boolean & void);
    // The first read finds nothing, so the set is what loses its race; the
    // re-read inside the conflict handler is what returns the concurrent state.
    jest
      .mocked(store.get)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        menuState({ lastEventId: 'event-a', lastReplyText: 'concurrent-menu' }),
      );

    const turn = await responder.handle({
      externalUserId: 'u1',
      userText: 'abc???',
      eventId: 'event-a',
      userId: 7,
    });

    expect(store.get).toHaveBeenCalledTimes(2);
    expect(turn).toEqual({
      kind: 'reply',
      text: 'concurrent-menu',
      skipDelivery: true,
    });
    expect(outcomes).toEqual(['replayed', 'skip_delivery']);
  });

  it('fails closed on a store outage and hands the failure up', async () => {
    const { responder, outcomes, failures, store } = buildStore();
    const failure = new Error('Redis clarification state unavailable');
    jest.mocked(store.get).mockRejectedValue(failure);

    const turn = await responder.handle({
      externalUserId: 'u1',
      userText: 'abc???',
      eventId: 'event-a',
      userId: 7,
    });

    expect(turn.kind).toBe('reply');
    expect(turn.kind === 'reply' && turn.skipDelivery).toBe(false);
    expect(outcomes).toEqual(['unavailable', 'blocked_tool']);
    expect(failures).toEqual([
      { externalUserId: 'u1', eventId: 'event-a', error: failure },
    ]);
  });

  it('keeps the identity fence on a delivery failure', async () => {
    const { responder, store } = buildStore(menuState());

    await responder.markDeliveryFailed('u1');
    await responder.markDeliveryFailed('u1', 'other-event');
    expect(store.set).not.toHaveBeenCalled();

    await responder.markDeliveryFailed('u1', 'menu-event');
    expect(store.set).toHaveBeenCalledWith(
      'discord:u1',
      expect.objectContaining({ lastDeliveryFailed: true, version: 3 }),
      2,
    );
  });

  // The type already has no `version` field on either turn; this pins the
  // runtime property a type cannot see — that no field named `version` survives
  // into the serialised turn, on both branches.
  it('returns a turn with no version field on either branch', async () => {
    const consumed = buildStore(
      menuState({ phase: 'consumed', lastEventId: 'other-event' }),
    );

    const continueTurn = await consumed.responder.handle({
      externalUserId: 'u1',
      userText: 'tiến độ của tôi thế nào',
      eventId: 'event-a',
      userId: 7,
    });

    const replayed = buildStore(menuState({ lastEventId: 'event-a' }));
    const replyTurn = await replayed.responder.handle({
      externalUserId: 'u1',
      userText: 'tiến độ của tôi thế nào',
      eventId: 'event-a',
      userId: 7,
    });

    expect(continueTurn.kind).toBe('continue');
    expect(replyTurn.kind).toBe('reply');
    expect(JSON.stringify(continueTurn)).not.toContain('version');
    expect(JSON.stringify(replyTurn)).not.toContain('version');
  });
});

describe('clarificationStateKey', () => {
  it('is the only builder of the state key', () => {
    expect(clarificationStateKey('messenger', 'psid-1')).toBe(
      'messenger:psid-1',
    );
    expect(clarificationStateKey('default', 'zalo-user-1')).toBe(
      'default:zalo-user-1',
    );
  });

  it('is what the responder stores under', async () => {
    const { responder, store } = buildStore();
    await responder.handle({
      externalUserId: 'u1',
      userText: 'abc???',
      eventId: 'event-a',
      userId: 7,
    });

    expect(store.get).toHaveBeenCalledWith(
      clarificationStateKey('discord', 'u1'),
    );
    expect(store.set).toHaveBeenCalledWith(
      clarificationStateKey('discord', 'u1'),
      expect.anything(),
      0,
    );
  });
});

describe('core and responder agree on the persisted shape', () => {
  // Pinned as a literal, not as another `ClarificationCore().begin(...)` call:
  // the shape is what a previous-generation pod reads during a rolling deploy,
  // so the assertion has to be able to fail when a field is added, renamed or
  // dropped. Only the canned menu text is left open — its wording is asserted
  // where the copy itself is tested.
  it('writes exactly the fields a first-generation pod reads back', async () => {
    const { responder, store } = buildStore();
    await responder.handle({
      externalUserId: 'u1',
      userText: 'abc???',
      eventId: 'event-a',
      userId: 7,
    });

    const written = jest.mocked(store.set).mock.calls[0][1];
    expect(Object.keys(written).sort()).toEqual([
      'attempts',
      'createdAt',
      'expiresAt',
      'lastDeliveryFailed',
      'lastEventId',
      'lastReplyText',
      'menuResets',
      'phase',
      'recentEventIds',
      'userId',
      'version',
    ]);
    expect(written).toEqual({
      phase: 'awaiting_choice',
      attempts: 0,
      menuResets: 0,
      version: 1,
      createdAt: NOW,
      expiresAt: NOW + DEFAULT_CLARIFICATION_LIMITS.ttlMs,
      userId: 7,
      lastEventId: 'event-a',
      recentEventIds: ['event-a'],
      lastReplyText: expect.any(String) as unknown as string,
      lastDeliveryFailed: false,
    });
  });
});
