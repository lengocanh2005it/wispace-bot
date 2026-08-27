import {
  ClarificationStateMachine,
  MemoryClarificationStateStore,
  RedisClarificationStateStore,
  createClarificationStateStore,
  type ClarificationState,
} from './clarification-state';

describe('ClarificationStateMachine', () => {
  const now = 1_700_000_000_000;

  it('normalizes Vietnamese variants and accepts numbered choices', () => {
    const machine = new ClarificationStateMachine();

    expect(machine.parseChoice('  Một  ')).toBe('progress');
    expect(machine.parseChoice('lich hoc')).toBe('schedule');
    expect(machine.parseChoice('ĐỔI LỊCH')).toBe('reschedule');
    expect(machine.parseChoice('3')).toBe('reschedule');
    expect(machine.parseChoice('the second one')).toBe('schedule');
    expect(machine.parseChoice('cái thứ 3')).toBe('reschedule');
    expect(machine.parseChoice('2 nhé')).toBe('schedule');
    expect(machine.parseChoice('chon mot')).toBe('progress');
    expect(machine.parseChoice('chon 2')).toBe('schedule');
    expect(machine.parseChoice('option 3')).toBe('reschedule');
    expect(machine.parseChoice('td')).toBe('progress');
    expect(machine.parseChoice('lh')).toBe('schedule');
    expect(machine.parseChoice('2nd')).toBe('schedule');
    expect(machine.parseChoice('option 2 nha')).toBe('schedule');
    expect(machine.parseChoice('lua chon 3 di')).toBe('reschedule');
    expect(machine.parseChoice('the first one nhe')).toBe('progress');
  });

  it('recognizes explicit cancellation without treating it as a tool intent', () => {
    const machine = new ClarificationStateMachine();

    expect(machine.isCancel('  huy  ')).toBe(true);
    expect(machine.isCancel('bỏ qua')).toBe(true);
    expect(machine.parseChoice('tiến độ')).toBe('progress');
  });

  it('treats contradictory choice batches as ambiguous', () => {
    const machine = new ClarificationStateMachine();

    expect(machine.isContradictory('lịch học\n3')).toBe(true);
    expect(machine.isContradictory('xem lịch học và đổi lịch học')).toBe(true);
    expect(machine.isContradictory('tiến độ và lịch học')).toBe(true);
    expect(machine.isContradictory('tiến độ, lịch học')).toBe(true);
    expect(machine.isContradictory('1 1')).toBe(false);
    expect(machine.isContradictory('mình muốn xem lịch học')).toBe(false);
    expect(machine.isContradictory('mình muốn dời lịch')).toBe(false);
  });

  it('uses configured bounds and retains event history for stale replies', () => {
    const machine = new ClarificationStateMachine({
      ttlMs: 30_000,
      maxAttempts: 1,
      maxMenuResets: 0,
    });
    const first = machine.withReply(machine.start(now), 'event-a', 'menu');
    const second = machine.withReply(
      machine.recordIrrelevant(first, now + 1).state!,
      'event-b',
      'menu-2',
    );

    expect(second.expiresAt).toBe(now + 1 + 30_000);
    expect(machine.getLimits()).toEqual({
      ttlMs: 30_000,
      maxAttempts: 1,
      maxMenuResets: 0,
    });
    expect(machine.isStaleEvent(second, 'event-a')).toBe(true);
    expect(machine.isStaleEvent(second, 'event-b')).toBe(false);
  });

  it('creates a bounded state and expires it after ten minutes', () => {
    const machine = new ClarificationStateMachine();
    const state = machine.start(now, 42);

    expect(state).toMatchObject<Partial<ClarificationState>>({
      phase: 'awaiting_choice',
      attempts: 0,
      menuResets: 0,
      userId: 42,
    });
    expect(machine.isExpired(state, now + 10 * 60 * 1000 - 1)).toBe(false);
    expect(machine.isExpired(state, now + 10 * 60 * 1000)).toBe(true);
  });

  it('bounds irrelevant follow-ups and opens only one fresh menu state', () => {
    const machine = new ClarificationStateMachine();
    const state = machine.start(now);

    const first = machine.recordIrrelevant(state, now + 1);
    const second = machine.recordIrrelevant(first.state, now + 2);
    const third = machine.recordIrrelevant(second.state, now + 3);

    expect(first.action).toBe('clarify');
    expect(second.action).toBe('clarify');
    expect(third.action).toBe('reset_menu');
    expect(third.state.menuResets).toBe(1);

    const afterReset = machine.recordIrrelevant(third.state, now + 4);
    expect(afterReset.action).toBe('clarify');
    const afterFreshLimit = machine.recordIrrelevant(
      machine.recordIrrelevant(afterReset.state!, now + 5).state!,
      now + 6,
    );
    expect(afterFreshLimit.action).toBe('clear');
    expect(afterFreshLimit.state).toBeUndefined();
  });

  it('increments versions so delayed state writes cannot win', () => {
    const machine = new ClarificationStateMachine();
    const state = machine.start(now);
    const next = machine.recordIrrelevant(state, now + 1).state;

    expect(next.version).toBeGreaterThan(state.version);
  });

  it('rejects a stale memory write using the expected version', async () => {
    const store = new MemoryClarificationStateStore();
    const machine = new ClarificationStateMachine();
    const state = machine.start(Date.now());

    await store.set('u1', state, 0);
    await expect(store.set('u1', { ...state, version: 2 }, 0)).resolves.toBe(
      false,
    );
  });

  it('consumes a choice with a compare-and-set tombstone', async () => {
    const store = new MemoryClarificationStateStore();
    const machine = new ClarificationStateMachine();
    const state = machine.withReply(
      machine.start(Date.now(), 42),
      'menu-1',
      'menu',
    );

    await store.set('u1', state, 0);
    const consumed = machine.consume(state, 'choice-1', Date.now());
    await expect(store.set('u1', consumed, state.version)).resolves.toBe(true);
    await expect(store.clear('u1', consumed.version)).resolves.toBe(true);
    await expect(store.clear('u1', consumed.version)).resolves.toBe(false);
  });

  it('fails closed when configured Redis is disabled or native client is missing', async () => {
    const machine = new ClarificationStateMachine();
    const state = machine.start(Date.now());

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

  it('creates memory store when Redis is not configured, and Redis store when configured', () => {
    const mockConfig = { get: jest.fn() };

    const memStore = createClarificationStateStore({
      platform: 'test',
      config: mockConfig,
    });
    expect(memStore).toBeInstanceOf(MemoryClarificationStateStore);

    const memStoreDisabledRedis = createClarificationStateStore({
      platform: 'test',
      config: mockConfig,
      redisClient: {
        isConfiguredEnabled: () => false,
        isEnabled: () => false,
        getNativeClient: () => null,
      } as never,
    });
    expect(memStoreDisabledRedis).toBeInstanceOf(MemoryClarificationStateStore);

    const redisStore = createClarificationStateStore({
      platform: 'test',
      config: mockConfig,
      redisClient: {
        isConfiguredEnabled: () => true,
        isEnabled: () => true,
        getNativeClient: () => ({}),
      } as never,
    });
    expect(redisStore).toBeInstanceOf(RedisClarificationStateStore);
  });
});
