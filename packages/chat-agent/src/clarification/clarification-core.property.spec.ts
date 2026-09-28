import fc from 'fast-check';
import {
  CLARIFICATION_INTERMEDIATE_DECISION_KINDS,
  CLARIFICATION_TERMINAL_DECISION_KINDS,
  ClarificationCore,
} from './clarification-core';
import type { ClarificationState } from './clarification-state';

fc.configureGlobal({ numRuns: 200 });

const now = 1_700_000_000_000;
const declaredKinds = new Set([
  ...CLARIFICATION_TERMINAL_DECISION_KINDS,
  ...CLARIFICATION_INTERMEDIATE_DECISION_KINDS,
]);

const arbitraryState = fc
  .record({
    phase: fc.constantFrom<'awaiting_choice' | 'consumed'>(
      'awaiting_choice',
      'consumed',
    ),
    attempts: fc.integer({ min: 0, max: 3 }),
    menuResets: fc.integer({ min: 0, max: 2 }),
    version: fc.integer({ min: 1, max: 1_000 }),
    expiresAt: fc.integer({ min: now - 1_000, max: now + 20 * 60 * 1000 }),
    lastEventId: fc.constantFrom<string | undefined>(
      undefined,
      'event-a',
      'event-b',
    ),
    lastChoice: fc.constantFrom<
      'progress' | 'schedule' | 'reschedule' | undefined
    >(undefined, 'schedule'),
    lastReplyText: fc.constantFrom<string | undefined>(
      undefined,
      'menu',
      'menu-2',
    ),
    lastDeliveryFailed: fc.constantFrom<boolean | undefined>(
      undefined,
      false,
      true,
    ),
  })
  .chain((partial) =>
    fc
      .record({
        createdAt: fc.constant(now),
        userId: fc.integer({ min: 1, max: 2 }),
        recentEventIds: fc.option(
          fc.array(fc.constantFrom('event-a', 'event-b'), {
            minLength: 0,
            maxLength: 3,
          }),
          { nil: undefined },
        ),
      })
      .map((rest) => ({ ...partial, ...rest })),
  ) as fc.Arbitrary<ClarificationState>;

const arbitraryEvent = fc.record({
  eventId: fc.constantFrom<string | undefined>(undefined, 'event-a', 'event-b'),
  userId: fc.constantFrom<number | undefined>(undefined, 1, 2),
});

describe('clarification core properties', () => {
  it('keeps irrelevant follow-ups within configured bounds and eventually clears', () => {
    fc.assert(
      fc.property(
        fc.record({
          ttlMs: fc.integer({ min: 1, max: 10_000 }),
          maxAttempts: fc.integer({ min: 0, max: 4 }),
          maxMenuResets: fc.integer({ min: 0, max: 3 }),
        }),
        (limits) => {
          const core = new ClarificationCore(limits);
          let state = core.begin({}, now, 'menu');
          let cleared = false;

          for (let step = 0; step < 40; step += 1) {
            const result = core.recordIrrelevant(
              state,
              { eventId: `event-${step}` },
              now + step + 1,
              'menu',
            );
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
            expect(state.lastReplyText).toBe('menu');
            expect(state.lastEventId).toBe(`event-${step}`);
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
          const core = new ClarificationCore();
          let state = core.begin({}, now, 'menu');

          eventNumbers.forEach((eventNumber, index) => {
            state = core.consume(
              state,
              { eventId: `event-${eventNumber}-${index}` },
              now + index + 1,
            );
          });

          expect(state.recentEventIds?.length).toBeLessThanOrEqual(8);
          expect(state.lastEventId).toBe(
            `event-${eventNumbers.at(-1)}-${eventNumbers.length - 1}`,
          );
          expect(
            core.inspect(state, { eventId: state.lastEventId }, now + 30).kind,
          ).toBe('replayed');
        },
      ),
    );
  });

  it('classifies every state and event pair as one declared decision kind', () => {
    const core = new ClarificationCore();

    fc.assert(
      fc.property(arbitraryState, arbitraryEvent, (state, event) => {
        const decision = core.inspect(state, event, now);

        expect(declaredKinds.has(decision.kind)).toBe(true);
        // A terminal suppression carries the learner's reply forward, so the
        // caller never has to re-read the state to answer with it.
        if (decision.kind === 'replayed' || decision.kind === 'stale_reply') {
          expect(decision.replyText).toBe(state.lastReplyText);
        }
      }),
    );
  });

  it('carries a previously accepted choice only for the event whose delivery failed', () => {
    const core = new ClarificationCore();

    fc.assert(
      fc.property(arbitraryState, arbitraryEvent, (state, event) => {
        const decision = core.inspect(state, event, now);
        if (decision.kind !== 'consumed') return;

        const reopening =
          state.phase === 'consumed' &&
          state.lastDeliveryFailed === true &&
          state.userId === event.userId &&
          state.expiresAt > now &&
          event.eventId === state.lastEventId;
        expect(decision.choice).toBe(reopening ? state.lastChoice : undefined);
      }),
    );
  });
});
