import {
  CLARIFICATION_TERMINAL_DECISION_KINDS,
  ClarificationCore,
} from './clarification-core';
import {
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
  it('covers every terminal kind and gives each one a non-empty outcome list', () => {
    expect(Object.keys(CLARIFICATION_TERMINAL_RULES).sort()).toEqual(
      [...CLARIFICATION_TERMINAL_DECISION_KINDS].sort(),
    );

    for (const kind of CLARIFICATION_TERMINAL_DECISION_KINDS) {
      expect(
        CLARIFICATION_TERMINAL_RULES[kind].outcomes.length,
      ).toBeGreaterThan(0);
    }
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

    await expect(
      failed.send({ userText: 'tiến độ của tôi thế nào' }),
    ).resolves.toBeUndefined();
    expect(failed.outcomes).toEqual(['choice']);

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

  it('counts a bounded irrelevant follow-up and a reset before clearing', async () => {
    const first = buildStore(menuState({ attempts: 0, menuResets: 0 }));
    await first.send({ userText: 'abc???' });
    expect(first.outcomes).toEqual(['irrelevant_clarify', 'blocked_tool']);

    const last = buildStore(menuState({ attempts: 2, menuResets: 1 }));
    await last.send({ userText: 'abc???' });
    expect(last.outcomes).toEqual(['blocked_tool', 'max_reset']);
    expect(last.store.clear).toHaveBeenCalledWith('discord:u1', 2);
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
    jest
      .mocked(store.get)
      .mockResolvedValueOnce(
        menuState({ lastEventId: 'event-a', lastReplyText: 'concurrent-menu' }),
      );

    const turn = await responder.handle({
      externalUserId: 'u1',
      userText: 'abc???',
      eventId: 'event-a',
      userId: 7,
    });

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

  it('keeps the version internal — nothing it returns carries one', async () => {
    const { responder } = buildStore(
      menuState({ phase: 'consumed', lastEventId: 'other-event' }),
    );

    const turn = await responder.handle({
      externalUserId: 'u1',
      userText: 'tiến độ của tôi thế nào',
      eventId: 'event-a',
      userId: 7,
    });

    expect(JSON.stringify(turn)).not.toContain('version');
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
  it('writes exactly what the core builds', async () => {
    const { responder, store } = buildStore();
    await responder.handle({
      externalUserId: 'u1',
      userText: 'abc???',
      eventId: 'event-a',
      userId: 7,
    });

    const written = jest.mocked(store.set).mock.calls[0][1];
    expect(written).toEqual(
      new ClarificationCore().begin(
        { eventId: 'event-a', userId: 7 },
        NOW,
        expect.any(String) as unknown as string,
      ),
    );
  });
});
