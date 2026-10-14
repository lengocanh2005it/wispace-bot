import { WebhookActionExecutorService } from './webhook-action-executor.service';
import type { MessengerWebhookEvent } from '../../domain/entities/messenger.types';
import {
  MemoryRescheduleAttemptStore,
  MemoryRescheduleStore,
  RescheduleConfirmationService,
  type RescheduleAttemptStorePort,
} from '@wispace/reschedule-confirm/core';

/**
 * The learner-facing seam: a learner taps confirm, and we assert the three
 * things that matter — how many calendar writes happened, what the durable
 * record says, and what the learner was told.
 */
describe('WebhookActionExecutorService.confirm_reschedule (#1418)', () => {
  const psid = 'psid-1';
  const token = '11111111-1111-4111-8111-111111111111';
  const event = { sender: { id: psid } } as MessengerWebhookEvent;
  const mapping = { id: 1, userId: 42, updatedAt: '2026-09-29' };

  const build = (
    overrides: {
      sendText?: jest.Mock;
      write?: jest.Mock;
    } = {},
  ) => {
    const calendarWrite =
      overrides.write ??
      jest.fn().mockResolvedValue({ scheduledTimeLabel: '20/09 lúc 19:00' });

    const store = new MemoryRescheduleStore<string>();
    const attemptStore: RescheduleAttemptStorePort =
      new MemoryRescheduleAttemptStore('messenger');

    Object.assign(store, { requiresApprovalToken: true });
    void store.save({
      externalId: psid,
      userId: 42,
      calendarId: 7,
      schedulingMode: 'fixed_time' as never,
      newLocalDate: '2026-09-20',
      newTime: '19:00',
      sessionLabel: 'IELTS Writing',
      expiresAt: Date.now() + 600_000,
      toolName: 'reschedule_study_session',
      platform: 'messenger',
      mappingVersion: '1:2026-09-29',
      intentHash: 'intent-1',
      argsHash: 'args-1',
      nonce: token,
    });

    const confirmation = new RescheduleConfirmationService(
      { listUpcomingEntries: jest.fn().mockResolvedValue([]) } as never,
      { rescheduleSession: calendarWrite } as never,
      store,
      {
        attemptStore,
        requiresApprovalToken: true,
      } as never,
    );

    const sendText = overrides.sendText ?? jest.fn().mockResolvedValue('sent');
    const outbound = {
      sendTextViaPsid: sendText,
      sendRichFollowUps: jest.fn().mockResolvedValue('sent'),
    };

    const messengerRepository = {
      findActiveMappingByPsid: jest.fn().mockResolvedValue(mapping),
    };

    const service = new WebhookActionExecutorService(
      { get: jest.fn() } as never,
      outbound as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      confirmation as never,
      {} as never,
      undefined,
      messengerRepository as never,
    );

    return {
      service,
      sendText,
      outbound,
      calendarWrite,
      attemptStore,
      confirm: () =>
        service.executeAction(
          {
            type: 'confirm_reschedule',
            psid,
            userId: 42,
            approvalToken: token,
          },
          event,
          jest.fn().mockResolvedValue(undefined),
        ),
    };
  };

  it('writes the calendar once and tells the learner it moved', async () => {
    const { confirm, calendarWrite, attemptStore, sendText } = build();

    await confirm();

    expect(calendarWrite).toHaveBeenCalledTimes(1);
    expect(await attemptStore.findAttempt(psid, token)).toMatchObject({
      status: 'confirmed',
      scheduledTimeLabel: '20/09 lúc 19:00',
    });
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({ messageType: 'RESCHEDULE_CONFIRMED' }),
    );
  });

  it('answers a second tap on the same token with the confirmation, not a failure', async () => {
    const { confirm, calendarWrite, sendText } = build();

    await confirm();
    sendText.mockClear();
    await confirm();

    // The confirm card stays live in the thread and cannot be disabled, so a
    // second tap is the simplest reproduction of the learner-visible bug.
    expect(calendarWrite).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({ messageType: 'RESCHEDULE_CONFIRMED' }),
    );
    expect(sendText).not.toHaveBeenCalledWith(
      expect.objectContaining({ messageType: 'RESCHEDULE_CONFIRM_FAILED' }),
    );
  });

  it('retries the confirmation when the first send is rate limited', async () => {
    const sendText = jest
      .fn()
      .mockResolvedValueOnce('rate_limited')
      .mockResolvedValueOnce('sent');
    const { confirm, attemptStore, calendarWrite } = build({ sendText });

    await confirm();

    expect(calendarWrite).toHaveBeenCalledTimes(1);
    expect(await attemptStore.findAttempt(psid, token)).toMatchObject({
      status: 'confirmed',
      notificationStatus: 'deferred',
    });
  });

  it('keeps a thrown send from turning a committed change into a failure notice', async () => {
    const sendText = jest
      .fn()
      .mockRejectedValue(new Error('Meta Send API 500'));
    const { confirm, calendarWrite, attemptStore } = build({ sendText });

    await expect(confirm()).rejects.toThrow('Meta Send API 500');

    expect(calendarWrite).toHaveBeenCalledTimes(1);
    expect(await attemptStore.findAttempt(psid, token)).toMatchObject({
      status: 'confirmed',
    });
  });

  it('leaves no attempt record when the calendar write provably failed', async () => {
    const write = jest.fn().mockRejectedValue(new Error('WISPACE 503'));
    const { confirm, sendText, attemptStore } = build({ write });

    await confirm();

    expect(await attemptStore.findAttempt(psid, token)).toBeNull();
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({ messageType: 'RESCHEDULE_CONFIRM_FAILED' }),
    );
  });

  it('tells the learner nothing when the write outcome cannot be determined', async () => {
    const attemptStore = new MemoryRescheduleAttemptStore('messenger');
    const store = new MemoryRescheduleStore<string>();
    Object.assign(store, { requiresApprovalToken: true });
    void store.save({
      externalId: psid,
      userId: 42,
      calendarId: 7,
      schedulingMode: 'fixed_time' as never,
      sessionLabel: 'IELTS Writing',
      expiresAt: Date.now() + 600_000,
      toolName: 'reschedule_study_session',
      platform: 'messenger',
      mappingVersion: '1:2026-09-29',
      intentHash: 'intent-1',
      argsHash: 'args-1',
      nonce: token,
    });
    // A write that started and never reported an outcome.
    await attemptStore.beginAttempt({
      externalId: psid,
      nonce: token,
      userId: 42,
    });

    const calendarWrite = jest.fn();
    const confirmation = new RescheduleConfirmationService(
      { listUpcomingEntries: jest.fn().mockResolvedValue([]) } as never,
      { rescheduleSession: calendarWrite } as never,
      store,
      { attemptStore, requiresApprovalToken: true } as never,
    );
    const sendText = jest.fn().mockResolvedValue('sent');
    const service = new WebhookActionExecutorService(
      { get: jest.fn() } as never,
      { sendTextViaPsid: sendText, sendRichFollowUps: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      confirmation as never,
      {} as never,
      undefined,
      {
        findActiveMappingByPsid: jest.fn().mockResolvedValue(mapping),
      } as never,
    );

    await service.executeAction(
      { type: 'confirm_reschedule', psid, userId: 42, approvalToken: token },
      event,
      jest.fn().mockResolvedValue(undefined),
    );

    expect(calendarWrite).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it('no longer sends a second rich message after the confirmation', async () => {
    const { confirm, outbound } = build();

    await confirm();

    expect(outbound.sendRichFollowUps).not.toHaveBeenCalled();
  });
});
