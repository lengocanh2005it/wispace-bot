/**
 * MiniMax adapter — OpenAI-compatible API, default base URL + model.
 */
import { OpenAiAdapter } from '../openai/openai-adapter';

const DEFAULT_MINIMAX_MODEL = 'MiniMax-Text-01';

export class MiniMaxAdapter extends OpenAiAdapter {
  constructor(
    getApiKey: () => string | undefined,
    getModel?: () => string,
    getBaseUrl?: () => string | undefined,
  ) {
    super(
      getApiKey,
      getModel ?? (() => DEFAULT_MINIMAX_MODEL),
      getBaseUrl ?? (() => 'https://api.minimax.chat/v1'),
      'minimax',
    );
  }
}
