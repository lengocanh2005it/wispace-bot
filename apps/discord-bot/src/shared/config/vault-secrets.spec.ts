import { loadVaultSecrets as loadSharedVaultSecrets } from '@wispace/bot-common/secrets';
import { loadVaultSecrets } from './vault-secrets';

jest.mock('@wispace/bot-common/secrets', () => ({
  loadVaultSecrets: jest.fn(),
}));

describe('discord Vault bootstrap adapter', () => {
  it('uses the fixed discord application identity', async () => {
    const sharedLoader = loadSharedVaultSecrets as jest.MockedFunction<
      typeof loadSharedVaultSecrets
    >;
    sharedLoader.mockResolvedValueOnce();

    await loadVaultSecrets();

    expect(sharedLoader).toHaveBeenCalledWith({ application: 'discord' });
  });
});
