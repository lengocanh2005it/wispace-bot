import type { AgentToolMap, AgentToolName } from './agent.tools';

type IncompleteProjection = {
  get_user_goals: readonly string[];
  throwaway_tool: readonly string[];
};

type AssertCompleteProjection<
  Projection extends AgentToolMap<readonly string[]>,
> = Projection;

export type IncompleteRegistryMustFail =
  // @ts-expect-error A new or existing tool cannot be omitted from a typed projection.
  AssertCompleteProjection<IncompleteProjection>;

type ThrowawayToolName = AgentToolName | 'throwaway_tool';
type ThrowawayProjection = Record<ThrowawayToolName, readonly string[]>;

type AssertThrowawayProjection<
  Projection extends AgentToolMap<readonly string[]>,
> = Projection;

export type ThrowawayRegistryMustFail = AssertThrowawayProjection<
  // @ts-expect-error Adding a throwaway tool still requires every registered tool entry.
  Pick<ThrowawayProjection, 'get_user_goals' | 'throwaway_tool'>
>;
