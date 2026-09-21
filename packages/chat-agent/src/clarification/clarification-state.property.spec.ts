import fc from 'fast-check';
import {
  ClarificationStateMachine,
  MemoryClarificationStateStore,
  normalizeClarificationText,
  type ClarificationChoice,
} from './clarification-state';

fc.configureGlobal({ numRuns: 200 });

const CHOICES: ReadonlyArray<{
  alias: string;
  choice: ClarificationChoice;
}> = [
  { alias: '1', choice: 'progress' },
  { alias: 'lich hoc', choice: 'schedule' },
  { alias: 'doi lich', choice: 'reschedule' },
  { alias: 'the second one', choice: 'schedule' },
  { alias: 'cái thứ 3', choice: 'reschedule' },
];

const EXPLICIT_CHOICES: ReadonlyArray<{
  alias: string;
  choice: ClarificationChoice;
}> = [
  { alias: '1', choice: 'progress' },
  { alias: '2', choice: 'schedule' },
  { alias: '3', choice: 'reschedule' },
  { alias: 'first one', choice: 'progress' },
  { alias: 'second one', choice: 'schedule' },
  { alias: 'third one', choice: 'reschedule' },
];

describe('clarification state properties', () => {
  it('normalizes arbitrary text to a fixed point', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const normalized = normalizeClarificationText(text);

        expect(normalizeClarificationText(normalized)).toBe(normalized);
        expect(normalized).not.toMatch(/\s{2,}/);
      }),
    );
  });

  it('parses aliases with harmless boundary whitespace and punctuation', () => {
    fc.assert(
      fc.property(fc.constantFrom(...CHOICES), (entry) => {
        const machine = new ClarificationStateMachine();

        expect(machine.parseChoice(`\n\t... ${entry.alias} !!!  `)).toBe(
          entry.choice,
        );
      }),
    );
  });

  it('detects contradictory distinct choices but not repeated identical choices', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...EXPLICIT_CHOICES),
        fc.constantFrom(...EXPLICIT_CHOICES),
        (first, second) => {
          const machine = new ClarificationStateMachine();
          const sameChoice = first.choice === second.choice;
          const text = `${first.alias} and ${second.alias}`;

          expect(machine.isContradictory(text)).toBe(!sameChoice);
        },
      ),
    );
  });

  it('keeps irrelevant follow-ups within configured bounds and eventually clears', () => {
    fc.assert(
      fc.property(
        fc.record({
          ttlMs: fc.integer({ min: 1, max: 10_000 }),
          maxAttempts: fc.integer({ min: 0, max: 4 }),
          maxMenuResets: fc.integer({ min: 0, max: 3 }),
        }),
        (limits) => {
          const machine = new ClarificationStateMachine(limits);
          const now = 1_700_000_000_000;
          let state = machine.start(now);
          let cleared = false;

          for (let step = 0; step < 40; step += 1) {
            const result = machine.recordIrrelevant(state, now + step + 1);
            if (result.action === 'clear') {
              cleared = true;
              expect(result.state).toBeUndefined();
              break;
            }

            expect(result.state).toBeDefined();
            state = result.state!;
            expect(state.attempts).toBeLessThanOrEqual(limits.maxAttempts);
            expect(state.menuResets).toBeLessThanOrEqual(limits.maxMenuResets);
            expect(state.version).toBeGreaterThan(1);
            expect(state.expiresAt).toBeGreaterThan(now);
          }

          expect(cleared).toBe(true);
        },
      ),
    );
  });

  it('keeps only the recent event tombstone window', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1_000_000 }), {
          minLength: 1,
          maxLength: 20,
        }),
        (eventNumbers) => {
          const machine = new ClarificationStateMachine();
          let state = machine.start(1_700_000_000_000);

          eventNumbers.forEach((eventNumber, index) => {
            state = machine.withReply(
              state,
              `event-${eventNumber}-${index}`,
              'menu',
            );
          });

          expect(state.recentEventIds?.length).toBeLessThanOrEqual(8);
          expect(state.lastEventId).toBe(
            `event-${eventNumbers.at(-1)}-${eventNumbers.length - 1}`,
          );
          expect(machine.isStaleEvent(state, state.lastEventId)).toBe(false);
        },
      ),
    );
  });

  it('rejects stale memory writes for every generated initial state', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 1_000_000 }),
        async (offset) => {
          const store = new MemoryClarificationStateStore();
          const state = new ClarificationStateMachine().start(
            Date.now() + offset,
          );

          await expect(store.set('user', state, 0)).resolves.toBe(true);
          await expect(
            store.set('user', { ...state, version: state.version + 1 }, 0),
          ).resolves.toBe(false);
          await expect(store.get('user')).resolves.toEqual(state);
        },
      ),
    );
  });
});
