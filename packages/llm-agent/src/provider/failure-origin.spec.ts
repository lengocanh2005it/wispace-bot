import { isRateLimitError, isServerError } from './failure-origin';

describe('failure-origin', () => {
  it('detects rate limit errors', () => {
    expect(
      isRateLimitError(
        Object.assign(new Error('rate limit'), {
          name: 'RateLimitError',
          status: 429,
        }),
      ),
    ).toBe(true);
  });

  it('detects server errors', () => {
    expect(
      isServerError(
        Object.assign(new Error('server'), {
          name: 'InternalServerError',
          status: 500,
        }),
      ),
    ).toBe(true);
  });

  it('does not treat Messenger API errors as provider server errors', () => {
    const error = Object.assign(new Error('Send failed'), {
      name: 'MessengerApiError',
      status: 500,
      responseBody: '{}',
    });
    expect(isServerError(error)).toBe(false);
  });
});
