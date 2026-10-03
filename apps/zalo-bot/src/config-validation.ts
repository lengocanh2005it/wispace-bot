import {
  collectCommonStartupViolations,
  createStartupValidationRunner,
  type StartupEnv,
  type StartupViolation,
} from '@wispace/bot-common/config';
import { collectLlmStartupViolations } from '@wispace/llm-agent/execution';
import { ZALO_BACKGROUND_PRODUCERS } from './modules/zalo-chat/report-producer';

/**
 * Every fail-closed constraint this release image would refuse to start on,
 * evaluated in one pass so a stale value is reported once instead of once per
 * deploy attempt (#1499).
 */
export function validateStartupConfig(env: StartupEnv): StartupViolation[] {
  return [
    ...collectCommonStartupViolations(env),
    ...collectLlmStartupViolations(env, ZALO_BACKGROUND_PRODUCERS),
  ];
}

export const runStartupValidation = createStartupValidationRunner({
  application: 'zalo',
  collect: validateStartupConfig,
});

if (require.main === module) {
  void runStartupValidation().then((code) => {
    // Vault and the provider SDK leave keep-alive sockets behind, so the loop
    // would not drain on its own and the deploy phase would wait on it.
    process.exit(code);
  });
}
