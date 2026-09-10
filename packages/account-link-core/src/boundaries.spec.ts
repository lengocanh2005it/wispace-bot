import * as adapters from './adapters';
import * as core from './core';

describe('account-link-core package boundaries', () => {
  it('publishes the lifecycle policies from the framework-free core entrypoint', () => {
    expect(core.LinkCompletionCore).toBeDefined();
    expect(core.LinkReconcileCronCore).toBeDefined();
    expect(core.OAuthStateCore).toBeDefined();
    expect(adapters).toBeDefined();
  });
});
