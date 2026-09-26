import fc from 'fast-check';
import { parseReminderOutput } from './reminder-formatter';

type ClassifiedOutcome<T> =
  | { kind: 'result'; value: T }
  | { kind: 'error'; error: unknown };

function classifyOutcome<T>(fn: () => T): ClassifiedOutcome<T> {
  try {
    return { kind: 'result', value: fn() };
  } catch (error) {
    return { kind: 'error', error };
  }
}

fc.configureGlobal({ numRuns: 200 });

describe('parseReminderOutput task-array boundary (#621 fuzz)', () => {
  it('applies Messenger text sanitization to prose and task items', () => {
    const output = parseReminderOutput(
      JSON.stringify({
        greeting: '**Hello**',
        intro: 'A *quick* reminder',
        tasks: ['**Task one**', 'Task two', 'Task three'],
        motivation: 'Keep _going_',
        signoff: '`Good luck`',
      }),
    );

    expect(output.prose).toEqual({
      greeting: 'Hello',
      intro: 'A quick reminder',
      tasks: ['Task one', 'Task two', 'Task three'],
      motivation: 'Keep going',
      signoff: 'Good luck',
    });
  });

  it('keeps only bounded, non-empty Messenger-safe tasks or rejects cleanly', () => {
    fc.assert(
      fc.property(fc.array(fc.jsonValue(), { maxLength: 20 }), (tasks) => {
        const content = JSON.stringify({
          greeting: 'Hello',
          intro: 'Reminder',
          tasks,
          motivation: 'Keep going',
          signoff: 'Good luck',
        });
        const outcome = classifyOutcome(() => parseReminderOutput(content));

        if (outcome.kind === 'result') {
          expect(outcome.value.prose.tasks.length).toBeGreaterThanOrEqual(3);
          expect(outcome.value.prose.tasks.length).toBeLessThanOrEqual(4);
          for (const task of outcome.value.prose.tasks) {
            expect(typeof task).toBe('string');
            expect(task.trim().length).toBeGreaterThan(0);
            expect(task.length).toBeLessThanOrEqual(183);
          }
        } else {
          expect(outcome.error).toBeInstanceOf(Error);
          expect((outcome.error as Error).message).toContain('tasks');
        }
      }),
    );
  });
});
