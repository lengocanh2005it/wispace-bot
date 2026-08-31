import { AGENT_TOOLS, getAgentToolDefinition } from '@wispace/llm-agent';
import {
  BUDGET_EXEMPT_TOOLS,
  WRITE_TOOL_NAMES,
  isWriteToolName,
} from './write-tool-budget';

describe('write-tool budget registry (#626)', () => {
  it('every non-read_only agent tool is either budgeted or explicitly exempt', () => {
    const unclassified = AGENT_TOOLS.filter(
      (t) =>
        t.capability.effect !== 'read_only' &&
        !isWriteToolName(t.name) &&
        !BUDGET_EXEMPT_TOOLS.has(t.name),
    ).map((t) => t.name);
    expect(unclassified).toEqual([]);
  });

  it('every WRITE_TOOL_NAMES entry is a real, non-read_only tool', () => {
    for (const name of WRITE_TOOL_NAMES) {
      const def = getAgentToolDefinition(name);
      expect(def).toBeDefined();
      expect(def!.capability.effect).not.toBe('read_only');
    }
  });
});
