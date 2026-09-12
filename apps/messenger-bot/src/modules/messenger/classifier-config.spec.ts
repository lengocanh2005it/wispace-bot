import {
  DEFAULT_CLASSIFIER_MODEL,
  resolveMessengerClassifierModel,
} from './classifier-config';

const POLICY = {
  nodeEnv: 'test',
  allowedBaseUrlHosts: ['api.openai.com'],
  allowedModels: ['openai:classifier-model'],
};

describe('resolveMessengerClassifierModel', () => {
  it('accepts an approved direct-provider classifier model', () => {
    expect(
      resolveMessengerClassifierModel({
        enabled: true,
        model: 'classifier-model',
        provider: 'openai',
        policy: POLICY,
      }),
    ).toBe('classifier-model');
  });

  it.each([undefined, '', 'unapproved-model'])(
    'rejects invalid model %j',
    (model) => {
      expect(() =>
        resolveMessengerClassifierModel({
          enabled: true,
          model,
          provider: 'openai',
          policy: POLICY,
        }),
      ).toThrow(/LLM_INPUT_CLASSIFIER_MODEL|LLM_ALLOWED_MODELS|approved/i);
    },
  );

  it('rejects an ambiguous multi-provider failover order', () => {
    expect(() =>
      resolveMessengerClassifierModel({
        enabled: true,
        model: 'classifier-model',
        failoverOrder: 'openai,openrouter',
        policy: POLICY,
      }),
    ).toThrow(/ambiguous multi-provider/i);
  });

  it('keeps the existing default when disabled', () => {
    expect(
      resolveMessengerClassifierModel({ enabled: false, policy: POLICY }),
    ).toBe(DEFAULT_CLASSIFIER_MODEL);
  });

  it('keeps the default when execution is disabled', () => {
    expect(
      resolveMessengerClassifierModel({
        enabled: true,
        executionEnabled: false,
        policy: POLICY,
      }),
    ).toBe(DEFAULT_CLASSIFIER_MODEL);
  });
});
