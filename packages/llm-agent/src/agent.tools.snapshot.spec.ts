import { AGENT_TOOLS } from './agent.tools';

describe('agent tool provider-facing JSON Schema (ADR 0010)', () => {
  it('matches the committed snapshot of the zod-derived registry', () => {
    expect(
      Object.fromEntries(
        AGENT_TOOLS.map((tool) => [tool.name, tool.parameters]),
      ),
    ).toMatchSnapshot();
  });
});
