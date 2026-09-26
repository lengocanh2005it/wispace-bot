import {
  isOpenAiRateLimitError,
  isOpenAiServerError,
} from './openai-error.utils';

describe('openai-error.utils', () => {
  it('detects OpenAI rate limit errors', () => {
    expect(
      isOpenAiRateLimitError(
        Object.assign(new Error('rate limit'), {
          name: 'RateLimitError',
          status: 429,
        }),
      ),
    ).toBe(true);
  });

  it('detects OpenAI server errors', () => {
    expect(
      isOpenAiServerError(
        Object.assign(new Error('server'), {
          name: 'InternalServerError',
          status: 500,
        }),
      ),
    ).toBe(true);
  });

  it('does not treat Messenger API errors as OpenAI server errors', () => {
    const error = Object.assign(new Error('Send failed'), {
      name: 'MessengerApiError',
      status: 500,
      responseBody: '{}',
    });
    expect(isOpenAiServerError(error)).toBe(false);
  });
});
