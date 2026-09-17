import { AGENT_TOOL_NAMES, deriveAgentToolMap } from '@wispace/llm-agent';
import {
  PLATFORM_TOOL_CONFORMANCE_MATRIX,
  PlatformToolExecutorPipeline,
  assertPlatformToolHandlerRegistry,
  withPlatformToolDecoration,
  type PlatformToolHandler,
} from './platform-tool-executor-pipeline';

describe('PlatformToolExecutorPipeline', () => {
  it('runs the shared lifecycle in order and decorates only valid results', async () => {
    const order: string[] = [];
    const decorate = jest.fn(() => {
      order.push('decorate');
    });
    const budget = {
      checkDailyAllowed: jest.fn().mockResolvedValue(true),
      consumeDaily: jest.fn().mockImplementation(async () => {
        order.push('budget');
        return true;
      }),
      refundDaily: jest.fn(),
    };
    const handlers = deriveAgentToolMap<PlatformToolHandler>(
      () => async () => ({ ok: true }),
    );
    handlers.precreate_next_exercise = async () => {
      order.push('handler');
      return withPlatformToolDecoration({ status: 'created' }, 'buttons');
    };

    const pipeline = new PlatformToolExecutorPipeline({
      handlers,
      getNotLinkedMessage: () => 'not linked',
      currentIdentityProvider: async () => {
        order.push('identity');
        return { userId: 7, mappingVersion: 'mapping-1' };
      },
      checkExplicitIntent: () => {
        order.push('intent');
        return true;
      },
      writeToolBudget: budget,
      decorateResult: decorate,
    });

    const ctx = {
      externalUserId: 'external-1',
      userText: 'create an exercise',
    };
    const result = await pipeline.execute('precreate_next_exercise', '{}', ctx);

    expect(result).toEqual({ status: 'created' });
    expect(ctx).toMatchObject({
      userId: 7,
      mappingVersion: 'mapping-1',
      identityVerified: true,
    });
    expect(order).toEqual([
      'identity',
      'intent',
      'budget',
      'handler',
      'decorate',
    ]);
    expect(decorate).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'precreate_next_exercise',
        result: { status: 'created' },
        decoration: 'buttons',
      }),
    );
  });

  it('rejects invalid and unknown calls before identity or handlers', async () => {
    const identity = jest.fn();
    const handler = jest.fn();
    const handlers = deriveAgentToolMap(() => handler);
    const policyDeniedInc = jest.fn();
    const pipeline = new PlatformToolExecutorPipeline({
      handlers,
      getNotLinkedMessage: () => 'not linked',
      currentIdentityProvider: identity,
      policyDeniedInc,
    });

    await expect(
      pipeline.execute('unknown', '{}', { externalUserId: 'x' }),
    ).resolves.toEqual({
      error: 'Unknown tool: unknown',
    });
    await expect(
      pipeline.execute('get_user_goals', '{', { externalUserId: 'x' }),
    ).resolves.toEqual({ error: 'Invalid tool arguments JSON' });

    expect(identity).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(policyDeniedInc).toHaveBeenCalledWith(
      'get_user_goals',
      'invalid_arguments',
    );
  });

  it('fails fast when a platform registry is incomplete', () => {
    const incomplete = Object.fromEntries(
      AGENT_TOOL_NAMES.slice(1).map((name) => [name, jest.fn()]),
    );

    expect(() =>
      assertPlatformToolHandlerRegistry(incomplete as never),
    ).toThrow(
      'Platform tool handler registry is incomplete: get_learning_progress_report',
    );
  });

  it('derives conformance entries for every registered capability', () => {
    expect(Object.keys(PLATFORM_TOOL_CONFORMANCE_MATRIX).sort()).toEqual(
      [...AGENT_TOOL_NAMES].sort(),
    );
    expect(
      Object.values(PLATFORM_TOOL_CONFORMANCE_MATRIX).every(
        ({ capability, metadata }) =>
          capability.identity === 'linked_wispace_account' &&
          typeof metadata.budget === 'string',
      ),
    ).toBe(true);
  });
});
