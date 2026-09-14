export interface ZaloClarificationAgentPort {
  clearClarificationState(zaloUserId: string): Promise<void>;
}

export const ZALO_CLARIFICATION_AGENT = Symbol('ZALO_CLARIFICATION_AGENT');
