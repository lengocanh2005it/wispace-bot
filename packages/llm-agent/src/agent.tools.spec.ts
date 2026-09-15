import {
  AGENT_TOOLS,
  AGENT_TOOL_NAMES,
  deriveAgentToolMap,
  getAgentToolNamesByGroundingClaim,
  isAgentToolName,
} from './agent.tools';

describe('agent tools', () => {
  it('derives the runtime name list and complete metadata from the registry', () => {
    expect(AGENT_TOOL_NAMES).toEqual(AGENT_TOOLS.map((tool) => tool.name));
    expect(
      AGENT_TOOLS.every(
        (tool) =>
          tool.metadata.observationFields.length > 0 &&
          tool.metadata.learnerLabel.length > 0 &&
          Array.isArray(tool.metadata.groundingClaims) &&
          ['none', 'write', 'exempt'].includes(tool.metadata.budget),
      ),
    ).toBe(true);
  });

  it('covers every registered tool in each derived policy projection', () => {
    const expectedNames = [...AGENT_TOOL_NAMES].sort();
    const projections = [
      deriveAgentToolMap((tool) => tool.metadata.observationFields),
      deriveAgentToolMap((tool) => tool.metadata.learnerLabel),
      deriveAgentToolMap((tool) =>
        tool.metadata.budget === 'write'
          ? tool.metadata.writeAction
          : undefined,
      ),
    ];

    for (const projection of projections) {
      expect(Object.keys(projection).sort()).toEqual(expectedNames);
    }

    for (const claim of [
      'goals',
      'progress',
      'schedule',
      'exercise',
    ] as const) {
      const expected = AGENT_TOOLS.filter((tool) =>
        tool.metadata.groundingClaims.includes(claim),
      )
        .map((tool) => tool.name)
        .sort();
      expect([...getAgentToolNamesByGroundingClaim(claim)].sort()).toEqual(
        expected,
      );
    }
  });

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
