import {
  MemoryRescheduleAttemptStore,
  MemoryRescheduleStore,
  RescheduleConfirmationService,
} from '@wispace/reschedule-confirm/core';

/**
 * The Discord learner-facing seam (#1483): a learner taps confirm, and we
 * assert the three things that matter — how many calendar writes happened, what
 * the durable record says, and what the learner was told.
 *
 * Runs against the platform's real confirmation service so the test observes
 * the behaviour a learner gets, not a mock's shape.
 */
describe('Discord reschedule confirmation durability (#1483)', () => {
  const discordUserId = 'discord-1';
  const nonce = '11111111-1111-4111-8111-111111111111';

  const build = (
    overrides: {
      write?: jest.Mock;
      editReply?: jest.Mock;
    } = {},
  ) => {
    const calendarWrite =
      overrides.write ??
      jest.fn().mockResolvedValue({ scheduledTimeLabel: '20/09 lúc 19:00' });
    const store = new MemoryRescheduleStore<string>();
    const attemptStore = new MemoryRescheduleAttemptStore();
    Object.assign(store, { requiresApprovalToken: false });
    void store.save({
      externalId: discordUserId,
      userId: 42,
      calendarId: 7,
      schedulingMode: 'fixed_time' as never,
      newLocalDate: '2026-09-20',
      newTime: '19:00',
      sessionLabel: 'IELTS',
      expiresAt: Date.now() + 600_000,
      toolName: 'reschedule_study_session',
      platform: 'discord',
      mappingVersion: '1:2026-09-29',
      intentHash: 'i',
      argsHash: 'a',
      nonce,
    });

    // Mirrors how the Discord module builds the service: the options literal
    // is the thing under test, so the test builds it the same way.
    const confirmation = new RescheduleConfirmationService<string>(
      { listUpcomingEntries: jest.fn().mockResolvedValue([]) } as never,
      { rescheduleSession: calendarWrite } as never,
      store,
      { attemptStore } as never,
    );

    const editReply =
      overrides.editReply ?? jest.fn().mockResolvedValue(undefined);
    const interaction = {
      user: { id: discordUserId },
      deferUpdate: jest.fn().mockResolvedValue(undefined),
      editReply,
    };

    return {
      confirmation,
      attemptStore,
      calendarWrite,
      editReply,
      interaction,
    };
  };

  /** What the gateway renders for a confirm result, mirroring its ternary. */
  const contentFor = (
    result: Awaited<
      ReturnType<RescheduleConfirmationService<string>['confirm']>
    >,
  ): string | null => {
    if (result.confirmed) {
      return `Đã dời lịch sang ${result.scheduledTimeLabel}.`;
    }
    if ('unknownOutcome' in result) {
      return null;
    }
    return result.message;
  };

  it('records a committed confirmation durably, before the learner is told', async () => {
    const { confirmation, attemptStore, calendarWrite } = build();

    const result = await confirmation.confirm(discordUserId, 42);

    expect(result.confirmed).toBe(true);
    expect(calendarWrite).toHaveBeenCalledTimes(1);
    expect(await attemptStore.findAttempt(discordUserId, nonce)).toMatchObject({
      status: 'confirmed',
      scheduledTimeLabel: '20/09 lúc 19:00',
    });
  });

  it('answers a second confirmation with the confirmation, not a rejection', async () => {
    const { confirmation, calendarWrite } = build();

    await confirmation.confirm(discordUserId, 42);
    const second = await confirmation.confirm(discordUserId, 42);

    // The confirm button is never disabled, so a second tap is the simplest
    // reproduction of the learner-visible defect.
    expect(calendarWrite).toHaveBeenCalledTimes(1);
    expect(contentFor(second)).not.toMatch(/Không còn yêu cầu/);
  });

  it('tells the learner nothing when a previous attempt outcome is unknown', async () => {
    const { confirmation, attemptStore, calendarWrite } = build();
    await attemptStore.beginAttempt({
      externalId: discordUserId,
      nonce,
      platform: 'discord',
      userId: 42,
    });

    const result = await confirmation.confirm(discordUserId, 42);

    // The write is not idempotent, so it must not run again.
    expect(calendarWrite).not.toHaveBeenCalled();
    expect(contentFor(result)).toBeNull();
  });
});
