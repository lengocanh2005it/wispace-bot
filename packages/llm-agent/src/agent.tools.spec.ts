import { AGENT_TOOLS, AGENT_TOOL_NAMES, isAgentToolName } from './agent.tools';

describe('agent tools', () => {
  it('exposes precreate_next_exercise as a no-argument tool', () => {
    expect(AGENT_TOOL_NAMES).toContain('precreate_next_exercise');
    expect(
      AGENT_TOOLS.find((tool) => tool.name === 'precreate_next_exercise'),
    ).toMatchObject({
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    });
    expect(isAgentToolName('precreate_next_exercise')).toBe(true);
  });
});
