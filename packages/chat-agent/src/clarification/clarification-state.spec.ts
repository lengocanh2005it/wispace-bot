import {
  ClarificationStateMachine,
  MemoryClarificationStateStore,
  RedisClarificationStateStore,
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
    expect(machine.isContradictory('1 1')).toBe(false);
    expect(machine.isContradictory('mình muốn xem lịch học')).toBe(false);
    expect(machine.isContradictory('mình muốn dời lịch')).toBe(false);
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

  it('consumes a choice with a compare-and-delete', async () => {
    const store = new MemoryClarificationStateStore();
    const state = new ClarificationStateMachine().start(Date.now(), 42);

    await store.set('u1', state, 0);
    await expect(store.clear('u1', state.version)).resolves.toBe(true);
    await expect(store.clear('u1', state.version)).resolves.toBe(false);
  });

  it('fails closed when configured Redis is unavailable', async () => {
    const store = new RedisClarificationStateStore(
      {
        isConfiguredEnabled: () => true,
        isEnabled: () => false,
        getNativeClient: () => null,
      },
      'chat:clarification:test',
    );

    await expect(store.get('u1')).rejects.toThrow('unavailable');
  });
});
