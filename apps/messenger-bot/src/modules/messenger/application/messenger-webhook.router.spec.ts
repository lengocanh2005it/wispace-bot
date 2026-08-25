import { MessengerWebhookEvent } from '../domain/entities/messenger.types';
import {
  CONFIRM_RESCHEDULE_POSTBACK,
  CANCEL_RESCHEDULE_POSTBACK,
} from './constants/messenger-reschedule.constants';
import { routeWebhookEvent, RouterContext } from './messenger-webhook.router';

function event(
  overrides: Partial<MessengerWebhookEvent> = {},
): MessengerWebhookEvent {
  return {
    sender: { id: 'psid-123' },
    ...overrides,
  };
}

function textEvent(text: string, mid?: string): MessengerWebhookEvent {
  return event({ message: { text, mid } });
}

function postbackEvent(payload: string): MessengerWebhookEvent {
  return event({ postback: { payload } });
}

function optinEvent(
  ref: string,
  topic?: string,
  cadence?: string,
): MessengerWebhookEvent {
  return event({
    optin: { ref, topic, frequency: cadence },
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function referralEvent(ref: string): MessengerWebhookEvent {
  return event({ referral: { ref } });
}

const defaultCtx: RouterContext = {};

describe('routeWebhookEvent', () => {
  describe('event classification', () => {
    it('ignores event without sender.id', () => {
      const actions = routeWebhookEvent({ sender: {} }, defaultCtx);
      expect(actions).toEqual([{ type: 'ignore' }]);
    });

    it('ignores event with no sender at all', () => {
      const actions = routeWebhookEvent({}, defaultCtx);
      expect(actions).toEqual([{ type: 'ignore' }]);
    });
  });

  describe('optin events', () => {
    it('returns link_user when optin has ref', () => {
      const actions = routeWebhookEvent(
        optinEvent('12345', 'IELTS', 'WEEKLY'),
        defaultCtx,
      );
      expect(actions).toEqual([
        {
          type: 'link_user',
          psid: 'psid-123',
          ref: '12345',
          topic: 'IELTS',
          cadence: 'WEEKLY',
        },
      ]);
    });

    it('returns link_user with default topic/cadence when optin ref has no topic/cadence', () => {
      const actions = routeWebhookEvent(optinEvent('12345'), defaultCtx);
      expect(actions).toEqual([
        {
          type: 'link_user',
          psid: 'psid-123',
          ref: '12345',
          topic: undefined,
          cadence: undefined,
        },
      ]);
    });

    it('ignores optin without ref', () => {
      const actions = routeWebhookEvent(event({ optin: {} }), defaultCtx);
      expect(actions).toEqual([{ type: 'ignore' }]);
    });
  });

  describe('referral events (no postback, no text)', () => {
    it('returns link_user when referral has ref', () => {
      const actions = routeWebhookEvent(
        event({ referral: { ref: '67890' } }),
        defaultCtx,
      );
      expect(actions).toEqual([
        {
          type: 'link_user',
          psid: 'psid-123',
          ref: '67890',
          topic: undefined,
          cadence: undefined,
        },
      ]);
    });

    it('ignores referral without ref', () => {
      const actions = routeWebhookEvent(event({ referral: {} }), defaultCtx);
      expect(actions).toEqual([{ type: 'ignore' }]);
    });
  });

  describe('text messages', () => {
    it('returns enqueue_chat when userId exists and mid is present', () => {
      const actions = routeWebhookEvent(
        textEvent('xem lich hoc cua minh', 'mid-1'),
        {
          ...defaultCtx,
          userId: 42,
        },
      );
      expect(actions).toEqual([
        {
          type: 'enqueue_chat',
          psid: 'psid-123',
          userId: 42,
          userText: 'xem lich hoc cua minh',
          idempotencyKey: 'mid-1',
        },
      ]);
    });

    it('returns send_text MISSING_USER_REF when userId is missing', () => {
      const actions = routeWebhookEvent(
        textEvent('xem lich hoc cua minh', 'mid-1'),
        defaultCtx,
      );
      expect(actions).toEqual([
        expect.objectContaining({
          type: 'send_text',
          psid: 'psid-123',
          messageType: 'MISSING_USER_REF',
        }),
      ]);
    });

    it('returns send_text CHAT_MISSING_MID when mid is missing and rate limit enforced', () => {
      const actions = routeWebhookEvent(textEvent('xem lich hoc cua minh'), {
        ...defaultCtx,
        userId: 42,
        shouldEnforceRateLimit: true,
      });
      expect(actions).toEqual([
        expect.objectContaining({
          type: 'send_text',
          psid: 'psid-123',
          messageType: 'CHAT_MISSING_MID',
        }),
      ]);
    });

    it('returns enqueue_chat when mid is missing but rate limit not enforced', () => {
      const actions = routeWebhookEvent(textEvent('xem lich hoc cua minh'), {
        ...defaultCtx,
        userId: 42,
        shouldEnforceRateLimit: false,
      });
      expect(actions).toEqual([
        expect.objectContaining({
          type: 'enqueue_chat',
          psid: 'psid-123',
          userId: 42,
          userText: 'xem lich hoc cua minh',
          idempotencyKey: undefined,
        }),
      ]);
    });

    it('ignores echo messages', () => {
      const actions = routeWebhookEvent(
        event({ message: { text: 'echo', is_echo: true, mid: 'mid-1' } }),
        { ...defaultCtx, userId: 42 },
      );
      expect(actions).toEqual([{ type: 'ignore' }]);
    });

    it('trims text before routing', () => {
      const actions = routeWebhookEvent(
        textEvent('  xem lich hoc cua minh  ', 'mid-1'),
        {
          ...defaultCtx,
          userId: 42,
        },
      );
      expect(actions).toEqual([
        expect.objectContaining({ userText: 'xem lich hoc cua minh' }),
      ]);
    });
  });

  describe('unsupported messages (sticker/attachment, no text)', () => {
    it('returns send_text UNSUPPORTED_MESSAGE_TYPE for sticker', () => {
      const actions = routeWebhookEvent(
        event({ message: { sticker_id: 123, mid: 'mid-1' } }),
        { ...defaultCtx, userId: 42 },
      );
      expect(actions).toEqual([
        expect.objectContaining({
          type: 'send_text',
          psid: 'psid-123',
          messageType: 'UNSUPPORTED_MESSAGE_TYPE',
        }),
      ]);
    });

    it('returns send_text UNSUPPORTED_MESSAGE_TYPE for attachment', () => {
      const actions = routeWebhookEvent(
        event({
          message: {
            attachments: [{ type: 'image' }],
            mid: 'mid-1',
          },
        }),
        { ...defaultCtx, userId: 42 },
      );
      expect(actions).toEqual([
        expect.objectContaining({
          type: 'send_text',
          psid: 'psid-123',
          messageType: 'UNSUPPORTED_MESSAGE_TYPE',
        }),
      ]);
    });

    it('does not treat text messages as unsupported', () => {
      const actions = routeWebhookEvent(
        textEvent('xem lich hoc cua minh', 'mid-1'),
        {
          ...defaultCtx,
          userId: 42,
        },
      );
      expect(actions[0].type).toBe('enqueue_chat');
    });
  });

  describe('postback classification', () => {
    it('returns register_report for GET_LEARNING_REPORT', () => {
      const ctx: RouterContext = {
        ...defaultCtx,
        linkContext: {
          ref: '1',
          topic: 'IELTS',
          cadence: 'WEEKLY',
          userId: 42,
        },
      };
      const actions = routeWebhookEvent(
        postbackEvent('GET_LEARNING_REPORT'),
        ctx,
      );
      expect(actions).toEqual([
        expect.objectContaining({
          type: 'register_report',
          psid: 'psid-123',
        }),
      ]);
    });

    it('returns register_report for SEND_OPT_IN', () => {
      const ctx: RouterContext = {
        ...defaultCtx,
        linkContext: {
          ref: '1',
          topic: 'IELTS',
          cadence: 'WEEKLY',
          userId: 42,
        },
      };
      const actions = routeWebhookEvent(postbackEvent('SEND_OPT_IN'), ctx);
      expect(actions[0].type).toBe('register_report');
    });

    it('returns register_report for REGISTER_LEARNING_REPORT', () => {
      const ctx: RouterContext = {
        ...defaultCtx,
        linkContext: {
          ref: '1',
          topic: 'IELTS',
          cadence: 'WEEKLY',
          userId: 42,
        },
      };
      const actions = routeWebhookEvent(
        postbackEvent('REGISTER_LEARNING_REPORT'),
        ctx,
      );
      expect(actions[0].type).toBe('register_report');
    });

    it('returns send_text MISSING_USER_REF when register_report has no context', () => {
      const actions = routeWebhookEvent(
        postbackEvent('GET_LEARNING_REPORT'),
        defaultCtx,
      );
      expect(actions).toEqual([
        expect.objectContaining({
          type: 'send_text',
          messageType: 'MISSING_USER_REF',
        }),
      ]);
    });

    it('returns send_report for VIEW_LEARNING_PROGRESS', () => {
      const actions = routeWebhookEvent(
        postbackEvent('VIEW_LEARNING_PROGRESS'),
        { ...defaultCtx, userId: 42 },
      );
      expect(actions).toEqual([
        expect.objectContaining({
          type: 'send_report',
          psid: 'psid-123',
          userId: 42,
        }),
      ]);
    });

    it('returns send_report for GET_LEARNING_PROGRESS', () => {
      const actions = routeWebhookEvent(
        postbackEvent('GET_LEARNING_PROGRESS'),
        { ...defaultCtx, userId: 42 },
      );
      expect(actions[0].type).toBe('send_report');
    });

    it('returns send_reminder_preview for VIEW_UPCOMING_STUDY_SESSION', () => {
      const actions = routeWebhookEvent(
        postbackEvent('VIEW_UPCOMING_STUDY_SESSION'),
        { ...defaultCtx, userId: 42 },
      );
      expect(actions).toEqual([
        expect.objectContaining({
          type: 'send_reminder_preview',
          psid: 'psid-123',
          userId: 42,
        }),
      ]);
    });

    it('returns send_reminder_preview for PREVIEW_STUDY_REMINDER', () => {
      const actions = routeWebhookEvent(
        postbackEvent('PREVIEW_STUDY_REMINDER'),
        { ...defaultCtx, userId: 42 },
      );
      expect(actions[0].type).toBe('send_reminder_preview');
    });

    it('returns confirm_reschedule for CONFIRM_RESCHEDULE', () => {
      const actions = routeWebhookEvent(
        postbackEvent(CONFIRM_RESCHEDULE_POSTBACK),
        { ...defaultCtx, userId: 42 },
      );
      expect(actions).toEqual([
        expect.objectContaining({
          type: 'confirm_reschedule',
          psid: 'psid-123',
          userId: 42,
        }),
      ]);
    });

    it('returns cancel_reschedule for CANCEL_RESCHEDULE', () => {
      const actions = routeWebhookEvent(
        postbackEvent(CANCEL_RESCHEDULE_POSTBACK),
        { ...defaultCtx, userId: 42 },
      );
      expect(actions).toEqual([
        expect.objectContaining({
          type: 'cancel_reschedule',
          psid: 'psid-123',
          userId: 42,
        }),
      ]);
    });

    it('returns send_welcome for GET_STARTED when link does not block', () => {
      const actions = routeWebhookEvent(postbackEvent('GET_STARTED'), {
        ...defaultCtx,
        userId: 42,
      });
      expect(actions).toEqual([
        expect.objectContaining({
          type: 'send_welcome',
          psid: 'psid-123',
          userId: 42,
        }),
      ]);
    });

    it('returns send_welcome for unknown postback payload (fallback)', () => {
      const actions = routeWebhookEvent(postbackEvent('UNKNOWN_PAYLOAD'), {
        ...defaultCtx,
        userId: 42,
      });
      expect(actions).toEqual([
        expect.objectContaining({
          type: 'send_welcome',
          psid: 'psid-123',
          userId: 42,
        }),
      ]);
    });
  });

  describe('ref verification (#383)', () => {
    const verifiedContext = {
      ref: '7',
      topic: 'IELTS',
      cadence: 'WEEKLY' as const,
      userId: 7,
    };
    const verifiedCtx: RouterContext = {
      userId: 7,
      linkContext: verifiedContext,
      refVerification: { status: 'verified', context: verifiedContext },
    };
    const mappedACtx: RouterContext = {
      userId: 42,
      linkContext: {
        ref: '42',
        topic: 'IELTS',
        cadence: 'WEEKLY',
        userId: 42,
      },
    };

    it('prepends link_user with verified context before chat on message referral', () => {
      const actions = routeWebhookEvent(
        event({
          message: {
            text: 'xem lich hoc',
            mid: 'mid-1',
            referral: { ref: '7' },
          },
        }),
        verifiedCtx,
      );
      expect(actions).toEqual([
        expect.objectContaining({
          type: 'link_user',
          ref: '7',
          context: verifiedContext,
        }),
        expect.objectContaining({ type: 'enqueue_chat', userId: 7 }),
      ]);
    });

    it('prepends link_user before register_report on postback with nested referral', () => {
      const actions = routeWebhookEvent(
        event({
          postback: { payload: 'GET_LEARNING_REPORT', referral: { ref: '7' } },
        }),
        {
          ...verifiedCtx,
          linkContext: verifiedContext,
        },
      );
      expect(actions[0]).toEqual(
        expect.objectContaining({
          type: 'link_user',
          context: verifiedContext,
        }),
      );
      expect(actions[1]).toEqual(
        expect.objectContaining({
          type: 'register_report',
          userId: 7,
          topic: 'IELTS',
          cadence: 'WEEKLY',
        }),
      );
    });

    it('routes postback actions for a top-level referral attached to a postback', () => {
      const actions = routeWebhookEvent(
        event({
          referral: { ref: '7' },
          postback: { payload: 'GET_LEARNING_REPORT' },
        }),
        verifiedCtx,
      );
      expect(actions[0]).toEqual(
        expect.objectContaining({ type: 'link_user' }),
      );
      expect(actions[1]).toEqual(
        expect.objectContaining({ type: 'register_report', userId: 7 }),
      );
    });

    it('emits exactly one link_user for optin when already pre-verified', () => {
      const actions = routeWebhookEvent(optinEvent('12345'), verifiedCtx);
      expect(actions).toEqual([
        expect.objectContaining({
          type: 'link_user',
          context: verifiedContext,
        }),
      ]);
    });

    it('emits exactly one link_user for pure referral when already pre-verified', () => {
      const actions = routeWebhookEvent(referralEvent('12345'), verifiedCtx);
      expect(actions).toEqual([
        expect.objectContaining({
          type: 'link_user',
          context: verifiedContext,
        }),
      ]);
    });

    describe('blocked relink attempt', () => {
      const blockedCtx: RouterContext = {
        ...mappedACtx,
        refVerification: { status: 'blocked' },
      };

      it('pure referral: sends MAPPING_RELINK_BLOCKED instead of link_user', () => {
        const actions = routeWebhookEvent(referralEvent('999'), blockedCtx);
        expect(actions).toEqual([
          expect.objectContaining({
            type: 'send_text',
            psid: 'psid-123',
            messageType: 'MAPPING_RELINK_BLOCKED',
          }),
        ]);
      });

      it('optin: sends MAPPING_RELINK_BLOCKED instead of link_user', () => {
        const actions = routeWebhookEvent(optinEvent('999'), blockedCtx);
        expect(actions).toEqual([
          expect.objectContaining({ messageType: 'MAPPING_RELINK_BLOCKED' }),
        ]);
      });

      it('text with message referral: notice first, then chat under existing identity', () => {
        const actions = routeWebhookEvent(
          event({
            message: {
              text: 'xem lich hoc',
              mid: 'mid-2',
              referral: { ref: '999' },
            },
          }),
          blockedCtx,
        );
        expect(actions).toEqual([
          expect.objectContaining({ messageType: 'MAPPING_RELINK_BLOCKED' }),
          expect.objectContaining({ type: 'enqueue_chat', userId: 42 }),
        ]);
      });

      it('postback register: notice first, then register_report under existing identity', () => {
        const ctx: RouterContext = {
          ...blockedCtx,
          linkContext: mappedACtx.linkContext,
        };
        const actions = routeWebhookEvent(
          event({
            postback: {
              payload: 'GET_LEARNING_REPORT',
              referral: { ref: '999' },
            },
          }),
          ctx,
        );
        expect(actions).toEqual([
          expect.objectContaining({ messageType: 'MAPPING_RELINK_BLOCKED' }),
          expect.objectContaining({
            type: 'register_report',
            userId: 42,
            topic: 'IELTS',
          }),
        ]);
      });
    });

    describe('failed verify', () => {
      const failedCtx: RouterContext = {
        ...mappedACtx,
        refVerification: { status: 'failed', failureReason: 'EXPIRED' },
      };
      const failedUnmappedCtx: RouterContext = {
        refVerification: { status: 'failed', failureReason: 'USED' },
      };

      it('unmapped text: only verify-failed notice, no MISSING_USER_REF duplicate', () => {
        const actions = routeWebhookEvent(
          event({
            message: {
              text: 'xem lich hoc',
              mid: 'mid-3',
              referral: { ref: 'bad' },
            },
          }),
          failedUnmappedCtx,
        );
        expect(actions).toEqual([
          expect.objectContaining({
            messageType: 'MESSENGER_LINK_VERIFY_FAILED',
          }),
        ]);
      });

      it('unmapped postback register: only verify-failed notice', () => {
        const actions = routeWebhookEvent(
          event({
            postback: {
              payload: 'GET_LEARNING_REPORT',
              referral: { ref: 'bad' },
            },
          }),
          failedUnmappedCtx,
        );
        expect(actions).toEqual([
          expect.objectContaining({
            messageType: 'MESSENGER_LINK_VERIFY_FAILED',
          }),
        ]);
      });

      it('pure referral: only verify-failed notice', () => {
        const actions = routeWebhookEvent(
          referralEvent('bad'),
          failedUnmappedCtx,
        );
        expect(actions).toEqual([
          expect.objectContaining({
            messageType: 'MESSENGER_LINK_VERIFY_FAILED',
          }),
        ]);
      });

      it('mapped text: verify-failed notice first, then chat under mapping identity', () => {
        const actions = routeWebhookEvent(
          event({
            message: {
              text: 'xem lich hoc',
              mid: 'mid-4',
              referral: { ref: 'bad' },
            },
          }),
          failedCtx,
        );
        expect(actions).toEqual([
          expect.objectContaining({
            messageType: 'MESSENGER_LINK_VERIFY_FAILED',
          }),
          expect.objectContaining({ type: 'enqueue_chat', userId: 42 }),
        ]);
      });

      it('optin: only verify-failed notice', () => {
        const actions = routeWebhookEvent(optinEvent('bad'), failedUnmappedCtx);
        expect(actions).toEqual([
          expect.objectContaining({
            messageType: 'MESSENGER_LINK_VERIFY_FAILED',
          }),
        ]);
      });
    });
  });

  describe('edge cases', () => {
    it('uses referral ref when both optin and referral present (referral checked first)', () => {
      const actions = routeWebhookEvent(
        event({
          optin: { ref: '111' },
          referral: { ref: '222' },
        }),
        defaultCtx,
      );
      expect(actions[0]).toEqual(
        expect.objectContaining({ type: 'link_user', ref: '222' }),
      );
    });

    it('prefers postback over text when both present', () => {
      const actions = routeWebhookEvent(
        event({
          postback: { payload: 'GET_STARTED' },
          message: { text: 'hello', mid: 'mid-1' },
        }),
        { ...defaultCtx, userId: 42 },
      );
      expect(actions[0].type).toBe('send_welcome');
    });

    it('trims text in enqueue_chat', () => {
      const actions = routeWebhookEvent(textEvent('  spaced  ', 'mid-1'), {
        ...defaultCtx,
        userId: 42,
      });
      expect(actions).toEqual([
        expect.objectContaining({ userText: 'spaced' }),
      ]);
    });
  });
});
