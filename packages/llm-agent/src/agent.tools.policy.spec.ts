import {
  AGENT_TOOLS,
  canonicalizeToolArguments,
  parseAndValidateToolArguments,
  validateAgentToolRegistry,
} from './agent.tools';

describe('agent tool policy registry', () => {
  it('defines a complete capability for every registered tool', () => {
    expect(() => validateAgentToolRegistry(AGENT_TOOLS)).not.toThrow();
    expect(AGENT_TOOLS).toHaveLength(8);
    expect(AGENT_TOOLS.every((tool) => tool.capability)).toBe(true);
    expect(
      AGENT_TOOLS.every((tool) =>
        tool.description.includes(`effect=${tool.capability.effect}`),
      ),
    ).toBe(true);
  });

  it('rejects malformed JSON and unknown arguments before dispatch', () => {
    expect(parseAndValidateToolArguments('get_user_goals', '{oops')).toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(
      parseAndValidateToolArguments(
        'get_user_goals',
        JSON.stringify({ userId: 42 }),
      ),
    ).toEqual(expect.objectContaining({ ok: false }));
    expect(
      parseAndValidateToolArguments(
        'get_user_goals',
        JSON.stringify({ toString: 1 }),
      ),
    ).toEqual(expect.objectContaining({ ok: false }));
  });

  it('rejects an incomplete capability definition at registry validation', () => {
    const broken = AGENT_TOOLS.map((tool) => ({ ...tool }));
    const first = broken[0];
    if (first) delete (first as { capability?: unknown }).capability;

    expect(() => validateAgentToolRegistry(broken as never)).toThrow(
      'Missing capability metadata',
    );
  });

  it('canonicalizes object key order for approval/idempotency hashes', () => {
    expect(canonicalizeToolArguments({ b: 2, a: { d: 4, c: 3 } })).toBe(
      '{"a":{"c":3,"d":4},"b":2}',
    );
  });
});
