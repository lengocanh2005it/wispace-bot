import { readFileSync } from 'fs';
import { join } from 'path';
import { runEvalFixture, ScriptedToolExecutor } from './eval-harness';

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

  it('fails when the core hash is stale (#646)', async () => {
    const fixture = JSON.parse(
      readFileSync(join(__dirname, '../../fixtures/greeting.json'), 'utf8'),
    ) as Record<string, unknown>;
    fixture.coreHash = 'b'.repeat(64);
    const result = await runEvalFixture(fixture);
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toContain(
      'core hash mismatch for CHAT_SYSTEM_PROMPT_CORE',
    );
  });

  it('fails when coreHash is missing (schema, #646)', async () => {
    const fixture = JSON.parse(
      readFileSync(join(__dirname, '../../fixtures/greeting.json'), 'utf8'),
    ) as Record<string, unknown>;
    delete fixture.coreHash;
    const result = await runEvalFixture(fixture);
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toContain(
      'coreHash must be a sha256 hex string',
    );
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

  it('records an args mismatch when the executor receives different serialized args', async () => {
    const executor = new ScriptedToolExecutor([
      {
        toolCalls: [{ name: 'get_user_goals', args: { limit: 3 } }],
      },
    ]);
    await executor.execute('get_user_goals', '{"limit":9}');
    expect(executor.argsMismatches.length).toBe(1);
    expect(executor.argsMismatches[0]).toContain(
      'tool "get_user_goals" args mismatch',
    );
  });

  it('records unexpected tool attempts', async () => {
    const executor = new ScriptedToolExecutor([
      { toolCalls: [{ name: 'get_user_goals', args: {} }] },
    ]);
    await executor
      .execute('precreate_next_exercise', '{}')
      .catch(() => undefined);
    expect(executor.unexpectedAttempts.length).toBe(1);
    expect(executor.unexpectedAttempts[0]).toContain(
      'unexpected tool "precreate_next_exercise"',
    );
  });

  it('fails when the scripted tool plan is not fully consumed', async () => {
    const fixture = JSON.parse(
      readFileSync(
        join(__dirname, '../../fixtures/single-tool-user-goals.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    fixture.expected = { planRemainder: 1 };
    const result = await runEvalFixture(fixture);
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toContain('scripted tool plan leftover');
  });

  it('fails when a request contract is not honored', async () => {
    const fixture = JSON.parse(
      readFileSync(
        join(__dirname, '../../fixtures/single-tool-user-goals.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    fixture.expected = {
      requestContracts: [{ systemPromptContains: ['no-such-fragment'] }],
    };
    const result = await runEvalFixture(fixture);
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toContain(
      'system prompt is missing "no-such-fragment"',
    );
  });

  it('fails when a request contract targets a round with no recorded request', async () => {
    const fixture = JSON.parse(
      readFileSync(join(__dirname, '../../fixtures/greeting.json'), 'utf8'),
    ) as Record<string, unknown>;
    fixture.expected = {
      requestContracts: [{ round: 5, toolsInclude: ['get_user_goals'] }],
    };
    const result = await runEvalFixture(fixture);
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toContain(
      'round 5 has no recorded request',
    );
  });
});
