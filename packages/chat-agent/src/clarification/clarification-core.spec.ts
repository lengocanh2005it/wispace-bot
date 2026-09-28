import {
  CLARIFICATION_INTERMEDIATE_DECISION_KINDS,
  CLARIFICATION_TERMINAL_DECISION_KINDS,
  ClarificationCore,
  type ClarificationDecision,
} from './clarification-core';
import {
  MemoryClarificationStateStore,
  RedisClarificationStateStore,
} from './clarification-state';

describe('ClarificationCore', () => {
  const now = 1_700_000_000_000;

  it('uses configured bounds and retains event history for stale replies', () => {
    const core = new ClarificationCore({
      ttlMs: 30_000,
      maxAttempts: 1,
      maxMenuResets: 0,
    });
    const first = core.begin({ eventId: 'event-a' }, now, 'menu');
    const second = core.recordIrrelevant(
      first,
      { eventId: 'event-b' },
      now + 1,
      'menu-2',
    ).state!;

    expect(second.expiresAt).toBe(now + 1 + 30_000);
    // The newest event is a replay, not an out-of-order reply.
    expect(core.inspect(second, { eventId: 'event-b' }, now + 1).kind).toBe(
      'replayed',
    );
    expect(core.inspect(second, { eventId: 'event-a' }, now + 1)).toEqual({
      kind: 'stale_reply',
      replyText: 'menu-2',
    });
  });

  it('creates a bounded state and expires it after ten minutes', () => {
    const core = new ClarificationCore();
    const state = core.begin({ userId: 42 }, now, 'menu');

    expect(state).toMatchObject({
      phase: 'awaiting_choice',
      attempts: 0,
      menuResets: 0,
      userId: 42,
    });
    expect(core.isExpired(state, now + 10 * 60 * 1000 - 1)).toBe(false);
    expect(core.isExpired(state, now + 10 * 60 * 1000)).toBe(true);
  });

  it('persists the state shape byte for byte', () => {
    const state = new ClarificationCore().begin(
      { eventId: 'menu-1', userId: 42 },
      now,
      'menu',
    );

    expect(JSON.parse(JSON.stringify(state))).toEqual({
      phase: 'awaiting_choice',
      attempts: 0,
      menuResets: 0,
      version: 1,
      createdAt: now,
      expiresAt: now + 10 * 60 * 1000,
      userId: 42,
      lastEventId: 'menu-1',
      recentEventIds: ['menu-1'],
      lastReplyText: 'menu',
      lastDeliveryFailed: false,
    });
  });

  it('bounds irrelevant follow-ups and opens only one fresh menu state', () => {
    const core = new ClarificationCore();
    const irrelevant = (state: ReturnType<typeof core.begin>, step: number) =>
      core.recordIrrelevant(
        state,
        { eventId: `event-${step}` },
        now + step,
        'menu',
      );

    const first = irrelevant(core.begin({}, now, 'menu'), 1);
    const second = irrelevant(first.state!, 2);
    const third = irrelevant(second.state!, 3);

    expect(first.action).toBe('clarify');
    expect(second.action).toBe('clarify');
    expect(third.action).toBe('reset_menu');
    expect(third.state!.menuResets).toBe(1);

    const afterReset = irrelevant(third.state!, 4);
    expect(afterReset.action).toBe('clarify');
    const afterFreshLimit = irrelevant(
      irrelevant(afterReset.state!, 5).state!,
      6,
    );
    expect(afterFreshLimit.action).toBe('clear');
    expect(afterFreshLimit.state).toBeUndefined();
  });

  it('increments versions so delayed state writes cannot win', () => {
    const core = new ClarificationCore();
    const state = core.begin({}, now, 'menu');
    const next = core.recordIrrelevant(state, {}, now + 1, 'menu').state!;
    const consumed = core.consume(next, { eventId: 'choice-1' }, now + 2);

    expect(state.version).toBe(1);
    expect(next.version).toBe(state.version + 1);
    expect(consumed.version).toBe(next.version + 1);
  });

  it('rejects a stale memory write using the expected version', async () => {
    const store = new MemoryClarificationStateStore();
    const state = new ClarificationCore().begin({}, Date.now(), 'menu');

    await store.set('u1', state, 0);
    await expect(store.set('u1', { ...state, version: 2 }, 0)).resolves.toBe(
      false,
    );
  });

  it('consumes a choice with a compare-and-set tombstone', async () => {
    const store = new MemoryClarificationStateStore();
    const core = new ClarificationCore();
    const state = core.begin({ userId: 42 }, Date.now(), 'menu');

    await store.set('u1', state, 0);
    const consumed = core.consume(
      state,
      { eventId: 'choice-1' },
      Date.now(),
      'schedule',
    );
    await expect(store.set('u1', consumed, state.version)).resolves.toBe(true);
    await expect(store.clear('u1', consumed.version)).resolves.toBe(true);
    await expect(store.clear('u1', consumed.version)).resolves.toBe(false);
  });

  it('persists the consumed choice for a delivery retry', () => {
    const state = new ClarificationCore().consume(
      new ClarificationCore().begin({}, Date.now(), 'menu'),
      { eventId: 'choice-1' },
      Date.now(),
      'schedule',
    );

    expect(state.lastChoice).toBe('schedule');
  });

  it('keeps a failed delivery retryable and fences it to the same event', () => {
    const core = new ClarificationCore();
    const state = core.begin({ eventId: 'menu-1' }, now, 'menu');

    expect(
      core.failDelivery(state, { eventId: 'other-event' }),
    ).toBeUndefined();
    expect(core.failDelivery(null, { eventId: 'menu-1' })).toBeUndefined();

    const failed = core.failDelivery(state, { eventId: 'menu-1' })!;
    expect(failed).toMatchObject({
      lastDeliveryFailed: true,
      version: state.version + 1,
    });
    expect(core.isExpired(failed, now)).toBe(false);
  });

  it('reports why a state cannot answer for the incoming event', () => {
    const core = new ClarificationCore();
    const state = core.begin({ userId: 42 }, now, 'menu');

    expect(core.inspect(state, { userId: 42 }, now + 10 * 60 * 1000)).toEqual({
      kind: 'stale_state',
      reason: 'expired',
    });
    expect(core.inspect(state, { userId: 7 }, now)).toEqual({
      kind: 'stale_state',
      reason: 'identity_reset',
    });
    expect(core.inspect(state, { userId: 42 }, now)).toEqual({
      kind: 'proceed',
    });
    expect(core.inspect(null, { userId: 42 }, now)).toEqual({
      kind: 'proceed',
    });
  });

  it('reopens a consumed state only for the event whose delivery failed', () => {
    const core = new ClarificationCore();
    const consumed = core.consume(
      core.begin({ eventId: 'menu-1' }, now, 'menu'),
      { eventId: 'choice-1' },
      now,
      'schedule',
    );
    const failed = core.failDelivery(consumed, { eventId: 'choice-1' })!;

    // #1035: a redelivery of the failed event replays the menu, a new message
    // that merely matches a choice is never swallowed by the tombstone.
    expect(core.inspect(consumed, { eventId: 'choice-1' }, now)).toEqual({
      kind: 'replayed',
      replyText: 'menu',
    });
    expect(core.inspect(failed, { eventId: 'choice-1' }, now)).toEqual({
      kind: 'consumed',
      choice: 'schedule',
    });
    expect(core.inspect(failed, { eventId: 'new-message' }, now)).toEqual({
      kind: 'consumed',
      choice: undefined,
    });
  });

  it('fails closed when configured Redis is disabled or native client is missing', async () => {
    const state = new ClarificationCore().begin({}, Date.now(), 'menu');

    const disabledStore = new RedisClarificationStateStore(
      {
        isConfiguredEnabled: () => true,
        isEnabled: () => false,
        getNativeClient: () => null,
      },
      'chat:clarification:test',
    );

    await expect(disabledStore.get('u1')).rejects.toThrow('unavailable');
    await expect(disabledStore.set('u1', state)).rejects.toThrow('unavailable');
    await expect(disabledStore.clear('u1')).rejects.toThrow('unavailable');

    const missingClientStore = new RedisClarificationStateStore(
      {
        isConfiguredEnabled: () => true,
        isEnabled: () => true,
        getNativeClient: () => null,
      },
      'chat:clarification:test',
    );

    await expect(missingClientStore.get('u1')).rejects.toThrow('unavailable');
    await expect(missingClientStore.set('u1', state)).rejects.toThrow(
      'unavailable',
    );
    await expect(missingClientStore.clear('u1')).rejects.toThrow('unavailable');

    const notConfiguredDirectStore = new RedisClarificationStateStore(
      {
        isConfiguredEnabled: () => false,
        isEnabled: () => false,
        getNativeClient: () => null,
      },
      'chat:clarification:test',
    );

    await expect(notConfiguredDirectStore.get('u1')).rejects.toThrow(
      'unavailable',
    );
    await expect(notConfiguredDirectStore.set('u1', state)).rejects.toThrow(
      'unavailable',
    );
    await expect(notConfiguredDirectStore.clear('u1')).rejects.toThrow(
      'unavailable',
    );
  });
});

describe('clarification decision vocabulary', () => {
  it('closes into thirteen terminal and three intermediate kinds', () => {
    // Widened deliberately: `has` taking a non-terminal kind must compile for
    // the disjointness assertion below, so the narrowing cannot hide a leak.
    const terminal: ReadonlySet<ClarificationDecision['kind']> = new Set(
      CLARIFICATION_TERMINAL_DECISION_KINDS,
    );

    expect(terminal.size).toBe(13);
    expect(CLARIFICATION_INTERMEDIATE_DECISION_KINDS).toHaveLength(3);
    expect(
      CLARIFICATION_INTERMEDIATE_DECISION_KINDS.filter((kind) =>
        terminal.has(kind),
      ),
    ).toEqual([]);
  });
});
