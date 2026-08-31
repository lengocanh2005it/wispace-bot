import { AGENT_TOOLS, AGENT_TOOL_NAMES, isAgentToolName } from './agent.tools';

describe('agent tools', () => {
  it('exposes precreate_next_exercise as a no-argument tool', () => {
    expect(AGENT_TOOL_NAMES).toContain('precreate_next_exercise');
    const tool = AGENT_TOOLS.find(
      (candidate) => candidate.name === 'precreate_next_exercise',
    );
    expect(tool).toMatchObject({
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    });
    expect(tool?.description).toContain(
      'không nhận tham số lựa chọn hay id tài nguyên',
    );
    expect(isAgentToolName('precreate_next_exercise')).toBe(true);
  });
});
