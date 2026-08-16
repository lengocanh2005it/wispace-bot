import { readFileSync } from 'fs';
import { join } from 'path';
import { runEvalFixture } from './eval-harness';

describe('eval harness self-checks (negative assertions)', () => {
  it('fails when the expected tool sequence does not match', async () => {
    const fixture = JSON.parse(
      readFileSync(
        join(__dirname, '../../fixtures/single-tool-user-goals.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    fixture.expected = { toolSequence: ['precreate_next_exercise'] };
    const result = await runEvalFixture(fixture);
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toContain('tool sequence mismatch');
  });

  it('fails when the prompt hash is stale', async () => {
    const fixture = JSON.parse(
      readFileSync(join(__dirname, '../../fixtures/greeting.json'), 'utf8'),
    ) as Record<string, unknown>;
    const promptFiles = fixture.promptFiles as Array<Record<string, unknown>>;
    promptFiles[0] = { ...promptFiles[0], hash: 'a'.repeat(64) };
    const result = await runEvalFixture(fixture);
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toContain('prompt hash mismatch');
  });

  it('fails on a fabricated reply via the no-fabrication guard', async () => {
    const fixture = JSON.parse(
      readFileSync(
        join(__dirname, '../../fixtures/single-tool-user-goals.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    fixture.expected = { replyTextNotContains: ['7.0'] };
    const result = await runEvalFixture(fixture);
    expect(result.ok).toBe(false);
  });

  it('fails on invalid tool args against the AGENT_TOOLS schema', async () => {
    const fixture = JSON.parse(
      readFileSync(join(__dirname, '../../fixtures/greeting.json'), 'utf8'),
    ) as Record<string, unknown>;
    fixture.script = [
      {
        toolCalls: [
          {
            name: 'reschedule_study_session',
            args: { schedulingMode: 'explicit' },
          },
        ],
      },
      { text: 'xong' },
    ];
    const result = await runEvalFixture(fixture);
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toContain(
      'missing required arg "calendarId"',
    );
  });
});
