export interface CleanupRetentionPolicy {
  configKey?: string;
  defaultDays?: number;
}

export interface CleanupCronPolicy {
  enabledConfigKey?: string;
  enabledFallbackConfigKey?: string;
  defaultEnabled: boolean;
  /** `null` explicitly marks a job with no retention semantics. */
  retention?: CleanupRetentionPolicy | null;
}

/** Explicit policy registry for cleanup names; unknown names fail closed. */
export class CleanupCronPolicyRegistry {
  private readonly policies = new Map<string, CleanupCronPolicy>();

  register(name: string, policy: CleanupCronPolicy): this {
    this.policies.set(name, policy);
    return this;
  }

  resolve(name: string): CleanupCronPolicy {
    const exact = this.policies.get(name);
    if (exact) return exact;
    throw new Error(`Unknown cleanup policy: ${name}`);
  }
}

export function createCleanupCronPolicyRegistry(): CleanupCronPolicyRegistry {
  const registry = new CleanupCronPolicyRegistry()
    .register('llm-usage-cleanup', {
      enabledConfigKey: 'LLM_USAGE_CLEANUP_ENABLED',
      enabledFallbackConfigKey: 'LLM_USAGE_ENABLED',
      defaultEnabled: true,
      retention: {
        configKey: 'LLM_USAGE_RETENTION_DAYS',
        defaultDays: 180,
      },
    })
    .register('chat-quota-events-cleanup', {
      enabledConfigKey: 'CHAT_QUOTA_EVENTS_CLEANUP_ENABLED',
      enabledFallbackConfigKey: 'CHAT_QUOTA_EVENTS_ENABLED',
      defaultEnabled: true,
      retention: {
        configKey: 'CHAT_QUOTA_EVENTS_RETENTION_DAYS',
        defaultDays: 365,
      },
    })
    .register('chat-idempotency-cleanup', {
      enabledConfigKey: 'CHAT_IDEMPOTENCY_CLEANUP_ENABLED',
      defaultEnabled: true,
      retention: {
        configKey: 'CHAT_IDEMPOTENCY_RETENTION_DAYS',
        defaultDays: 90,
      },
    });

  for (const platform of ['messenger', 'discord', 'zalo'] as const) {
    const prefix = platform.toUpperCase();
    registry
      .register(`${platform}-message-log-cleanup`, {
        enabledConfigKey: `${prefix}_MESSAGE_LOG_CLEANUP_ENABLED`,
        defaultEnabled: true,
        retention: {
          configKey: `${prefix}_MESSAGE_LOG_RETENTION_DAYS`,
          defaultDays: 90,
        },
      })
      .register(`${platform}-dead-letter-cleanup`, {
        enabledConfigKey: `${prefix}_DEAD_LETTER_CLEANUP_ENABLED`,
        defaultEnabled: true,
        retention: {
          configKey: `${prefix}_DEAD_LETTER_RETENTION_DAYS`,
          defaultDays: 30,
        },
      })
      .register(`${platform}-idempotency-recovery`, {
        defaultEnabled: true,
        retention: null,
      })
      .register(`${platform}-idempotency-cleanup`, {
        defaultEnabled: true,
        retention: {
          configKey: 'CHAT_IDEMPOTENCY_RETENTION_DAYS',
          defaultDays: 90,
        },
      })
      .register(`${platform}-oauth-state-cleanup`, {
        enabledConfigKey: `${prefix}_OAUTH_STATE_CLEANUP_ENABLED`,
        defaultEnabled: true,
        retention: null,
      })
      .register(`${platform}-report-claims-cleanup`, {
        enabledConfigKey: `${prefix}_REPORT_CLAIMS_CLEANUP_ENABLED`,
        defaultEnabled: true,
        retention: {
          configKey: `${prefix}_REPORT_CLAIMS_RETENTION_DAYS`,
          defaultDays: 90,
        },
      })
      .register(`${platform}-platform-link-audit-cleanup`, {
        enabledConfigKey: 'PLATFORM_LINK_AUDIT_CLEANUP_ENABLED',
        defaultEnabled: true,
        retention: {
          configKey: 'PLATFORM_LINK_AUDIT_RETENTION_DAYS',
          defaultDays: 90,
        },
      });
  }

  return registry;
}
