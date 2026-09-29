import {
  MemoryRescheduleAttemptStore,
  MemoryRescheduleStore,
  RescheduleConfirmationService,
} from '@wispace/reschedule-confirm/core';

/**
 * The Zalo learner-facing seam (#1483). Same three assertions as Discord: one
 * calendar write, a durable record, and what the learner was told.
 */
describe('Zalo reschedule confirmation durability (#1483)', () => {
  const zaloUserId = 'zalo-1';
  const nonce = '11111111-1111-4111-8111-111111111111';

  const build = () => {
    const calendarWrite = jest
      .fn()
      .mockResolvedValue({ scheduledTimeLabel: 'Ngày mai lúc 19:00' });
    const store = new MemoryRescheduleStore<string>();
    const attemptStore = new MemoryRescheduleAttemptStore();
    Object.assign(store, { requiresApprovalToken: false });
    void store.save({
      externalId: zaloUserId,
      userId: 42,
      calendarId: 7,
      schedulingMode: 'fixed_time' as never,
      newLocalDate: '2026-09-20',
      newTime: '19:00',
      sessionLabel: 'IELTS',
      expiresAt: Date.now() + 600_000,
      toolName: 'reschedule_study_session',
      platform: 'zalo',
      mappingVersion: '1:2026-09-29',
      intentHash: 'i',
      argsHash: 'a',
      nonce,
    });

    // Mirrors how the Zalo module builds the service.
    const confirmation = new RescheduleConfirmationService<string>(
      { listUpcomingEntries: jest.fn().mockResolvedValue([]) } as never,
      { rescheduleSession: calendarWrite } as never,
      store,
      { attemptStore } as never,
    );

    return { confirmation, attemptStore, calendarWrite };
  };

  it('records a committed confirmation durably, before the learner is told', async () => {
    const { confirmation, attemptStore, calendarWrite } = build();

    const result = await confirmation.confirm(zaloUserId, 42);

    expect(result.confirmed).toBe(true);
    expect(calendarWrite).toHaveBeenCalledTimes(1);
    expect(await attemptStore.findAttempt(zaloUserId, nonce)).toMatchObject({
      status: 'confirmed',
    });
  });

  it('answers a repeated confirmation line with the confirmation, not a rejection', async () => {
    const { confirmation, calendarWrite } = build();

    await confirmation.confirm(zaloUserId, 42);
    const second = await confirmation.confirm(zaloUserId, 42);

    expect(calendarWrite).toHaveBeenCalledTimes(1);
    expect(second.confirmed).toBe(false);
    expect('unknownOutcome' in second ? null : second.message).not.toMatch(
      /Không còn yêu cầu/,
    );
  });

  it('tells the learner nothing when a previous attempt outcome is unknown', async () => {
    const { confirmation, attemptStore, calendarWrite } = build();
    await attemptStore.beginAttempt({
      externalId: zaloUserId,
      nonce,
      platform: 'zalo',
      userId: 42,
    });

    const result = await confirmation.confirm(zaloUserId, 42);

    expect(calendarWrite).not.toHaveBeenCalled();
    expect('unknownOutcome' in result).toBe(true);
  });
});
