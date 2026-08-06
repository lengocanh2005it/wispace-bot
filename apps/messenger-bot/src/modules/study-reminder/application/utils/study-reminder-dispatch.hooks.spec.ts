import { MessengerApiError } from '@messenger/modules/messenger/application/services/messenger-outbound.service';
import { WispaceApiError } from '@messenger/shared/errors/wispace-api.error';
import { classifyMessengerDispatchFailure } from './study-reminder-dispatch.hooks';

describe('classifyMessengerDispatchFailure', () => {
  const base = {
    externalUserId: 'psid-1',
    jobId: 1,
    retryCount: 0,
    maxRetries: 3,
  };

  it('marks the Messenger 24h window as terminal with a normalized message (L2)', () => {
    const error = new MessengerApiError(
      'Send failed',
      400,
      'Bad Request',
      '{"error":{"code":10}}',
    );

    const result = classifyMessengerDispatchFailure({ ...base, error });

    expect(result).toEqual({
      terminal: true,
      errorMessage: 'Messenger 24h messaging window closed',
    });
  });

  it('marks non-retryable Wispace errors as terminal', () => {
    const error = new WispaceApiError(
      'Not Found',
      404,
      'psid-1',
      'UserCalendar',
    );

    const result = classifyMessengerDispatchFailure({ ...base, error });

    expect(result.terminal).toBe(true);
    expect(result.errorMessage).toBe('Not Found');
  });

  it('does not mark retryable Wispace errors (5xx) as terminal', () => {
    const error = new WispaceApiError('Timeout', 503, 'psid-1', 'UserCalendar');

    const result = classifyMessengerDispatchFailure({ ...base, error });

    expect(result.terminal).toBe(false);
  });

  it('marks terminal when retries are exhausted', () => {
    const result = classifyMessengerDispatchFailure({
      ...base,
      error: new Error('Persistent error'),
      retryCount: 3,
    });

    expect(result.terminal).toBe(true);
    expect(result.errorMessage).toBe('Persistent error');
  });

  it('treats transient errors as retryable', () => {
    const result = classifyMessengerDispatchFailure({
      ...base,
      error: new Error('Transient network error'),
    });

    expect(result.terminal).toBe(false);
  });
});
