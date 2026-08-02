/**
 * OpenRouter adapter — OpenAI-compatible API, default base URL + model.
 */
import { OpenAiAdapter } from '../openai/openai-adapter';

const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-4o-mini';

export class OpenRouterAdapter extends OpenAiAdapter {
  constructor(
    getApiKey: () => string | undefined,
    getModel?: () => string,
    getBaseUrl?: () => string | undefined,
  ) {
    super(
      getApiKey,
      getModel ?? (() => DEFAULT_OPENROUTER_MODEL),
      getBaseUrl ?? (() => 'https://openrouter.ai/api/v1'),
      'openrouter',
    );
  }
}
