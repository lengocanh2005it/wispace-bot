import {
  CleanupCronPolicyRegistry,
  createCleanupCronPolicyRegistry,
} from './cleanup-policy.registry';

describe('CleanupCronPolicyRegistry', () => {
  it('resolves explicit cleanup retention and enabled settings', () => {
    const policy =
      createCleanupCronPolicyRegistry().resolve('llm-usage-cleanup');

    expect(policy).toEqual({
      enabledConfigKey: 'LLM_USAGE_CLEANUP_ENABLED',
      enabledFallbackConfigKey: 'LLM_USAGE_ENABLED',
      defaultEnabled: true,
      retention: {
        configKey: 'LLM_USAGE_RETENTION_DAYS',
        defaultDays: 180,
      },
    });
  });

  it('represents recovery work without retention semantics', () => {
    expect(
      createCleanupCronPolicyRegistry().resolve('discord-idempotency-recovery'),
    ).toEqual({ defaultEnabled: true, retention: null });
  });

  it('rejects unknown policy names', () => {
    const registry = new CleanupCronPolicyRegistry();

    expect(() => registry.resolve('renamed-cleanup')).toThrow(
      'Unknown cleanup policy',
    );
  });
});
