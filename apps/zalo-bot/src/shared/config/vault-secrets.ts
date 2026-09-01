import { loadVaultSecrets as loadSharedVaultSecrets } from '@wispace/bot-common/secrets';

export function loadVaultSecrets(): Promise<void> {
  return loadSharedVaultSecrets({ application: 'zalo' });
}
