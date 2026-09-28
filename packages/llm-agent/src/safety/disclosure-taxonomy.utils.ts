export const DISCLOSURE_CATEGORY = {
  agentToolArchitecture: 'agent_tool_architecture',
  systemPrompt: 'system_prompt',
  samplingParameters: 'sampling_parameters',
  runtimeIdentityHosting: 'runtime_identity_hosting',
  environmentVariables: 'environment_variables',
  filePaths: 'file_paths',
  internalRateLimits: 'internal_rate_limits',
  safetyAbuseDetection: 'safety_abuse_detection',
} as const;

export type DisclosureCategory =
  (typeof DISCLOSURE_CATEGORY)[keyof typeof DISCLOSURE_CATEGORY];
