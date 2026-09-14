import {
  MessengerApiError as ContractMessengerApiError,
  MessengerPartialSendError as ContractMessengerPartialSendError,
  isMessenger24hWindowError as isContract24hWindowError,
  isMessengerAmbiguousDeliveryError as isContractAmbiguousDeliveryError,
  isMessengerSenderActionError as isContractSenderActionError,
} from './messenger-delivery.contract';
import {
  MessengerApiError as OutboundMessengerApiError,
  MessengerPartialSendError as OutboundMessengerPartialSendError,
  isMessenger24hWindowError as isOutbound24hWindowError,
  isMessengerAmbiguousDeliveryError as isOutboundAmbiguousDeliveryError,
} from '../services/messenger-outbound.service';
import {
  MessengerApiError as ChatMessengerApiError,
  isMessenger24hWindowError as isChat24hWindowError,
} from '../messages/chat-delivery.messages';

describe('Messenger delivery contract (#435)', () => {
  it('keeps legacy exports identical to the neutral contract', () => {
    expect(OutboundMessengerApiError).toBe(ContractMessengerApiError);
    expect(ChatMessengerApiError).toBe(ContractMessengerApiError);
    expect(OutboundMessengerPartialSendError).toBe(
      ContractMessengerPartialSendError,
    );
    expect(isOutbound24hWindowError).toBe(isContract24hWindowError);
    expect(isChat24hWindowError).toBe(isContract24hWindowError);
    expect(isOutboundAmbiguousDeliveryError).toBe(
      isContractAmbiguousDeliveryError,
    );
  });

  it('preserves partial-send metadata and instanceof identity', () => {
    const cause = new ContractMessengerApiError(
      'Send failed',
      500,
      'Internal Server Error',
      '{"error":{"code":1}}',
    );
    const partial = new ContractMessengerPartialSendError(2, cause);

    expect(partial).toBeInstanceOf(ContractMessengerApiError);
    expect(partial).toBeInstanceOf(OutboundMessengerApiError);
    expect(partial.bubblesSent).toBe(2);
    expect(partial.status).toBe(cause.status);
    expect(partial.statusText).toBe(cause.statusText);
    expect(partial.responseBody).toBe(cause.responseBody);
  });

  it('keeps sender-action precedence over 24-hour detection', () => {
    const error = new ContractMessengerApiError(
      'Sender action failed outside the allowed window',
      400,
      'Bad Request',
      '{"error":{"code":10,"error_subcode":2018048,"message":"outside the allowed window"}}',
    );

    expect(isContractSenderActionError(error)).toBe(true);
    expect(isContract24hWindowError(error)).toBe(false);
    expect(isOutbound24hWindowError(error)).toBe(false);
    expect(isChat24hWindowError(error)).toBe(false);
  });
});
