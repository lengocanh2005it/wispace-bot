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

  it('recognises only the one platform error name that exists', () => {
    // Discord and Zalo never shipped a `*ApiError`; their delivery errors are
    // DiscordDeliveryFailureError/DiscordRateLimitError and ZaloSendError/
    // ZaloRateLimitError. This asserts the guard's actual scope rather than
    // the names it was forward-written with.
    expect(
      isServerError(
        Object.assign(new Error('send failed'), {
          name: 'MessengerApiError',
          status: 500,
        }),
      ),
    ).toBe(false);

    // A 5xx from a platform whose error is not a platform error reads as a
    // provider server error — the pre-existing consequence of the guard never
    // matching Discord or Zalo, pinned here so widening it is a deliberate act.
    expect(
      isServerError(
        Object.assign(new Error('send failed'), {
          name: 'DiscordDeliveryFailureError',
          status: 500,
        }),
      ),
    ).toBe(true);
  });
});
