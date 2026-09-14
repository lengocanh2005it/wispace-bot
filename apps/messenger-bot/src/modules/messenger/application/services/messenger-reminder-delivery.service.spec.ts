import { MessengerReminderDeliveryService } from './messenger-reminder-delivery.service';

describe('MessengerReminderDeliveryService', () => {
  const buildService = (overrides?: {
    getNextUpcomingSession?: jest.Mock;
    generateReminderBundleForSession?: jest.Mock;
    sendTextViaPsid?: jest.Mock;
  }) => {
    const studyReminder = {
      getNextUpcomingSession: overrides?.getNextUpcomingSession ?? jest.fn(),
      generateReminderBundleForSession:
        overrides?.generateReminderBundleForSession ?? jest.fn(),
      getOutboxSettings: jest.fn().mockReturnValue({ minutesBefore: 30 }),
    };

    const outbound = {
      sendTextViaPsid:
        overrides?.sendTextViaPsid ?? jest.fn().mockResolvedValue(undefined),
    };

    const service = new MessengerReminderDeliveryService(
      outbound as never,
      studyReminder as never,
    );

    return {
      service,
      studyReminder,
      outbound,
    };
  };

  describe('sendReminderPreview', () => {
    it('sends empty message when no upcoming session', async () => {
      const { service, studyReminder, outbound } = buildService();
      studyReminder.getNextUpcomingSession.mockResolvedValue(null);

      const result = await service.sendReminderPreview('psid-1', 10);

      expect(result).toContain('chưa có buổi học');
      expect(outbound.sendTextViaPsid).toHaveBeenCalledWith(
        expect.objectContaining({
          psid: 'psid-1',
          userId: 10,
          messageType: 'STUDY_SESSION_REMINDER_EMPTY',
        }),
      );
    });

    it('sends reminder when session exists', async () => {
      const session = {
        sessionKey: 'sk-1',
        scheduledAt: new Date('2026-07-10T10:00:00Z'),
        topic: 'IELTS Writing',
        durationMinutes: 60,
      };

      const { service, studyReminder, outbound } = buildService();
      studyReminder.getNextUpcomingSession.mockResolvedValue(session);
      studyReminder.generateReminderBundleForSession.mockResolvedValue({
        text: 'Nhớ học lúc 10h nhé!',
        output: {} as never,
      });

      const result = await service.sendReminderPreview('psid-1', 10);

      expect(result).toBe('Nhớ học lúc 10h nhé!');
      expect(outbound.sendTextViaPsid).toHaveBeenCalledWith(
        expect.objectContaining({
          psid: 'psid-1',
          userId: 10,
          messageType: 'STUDY_SESSION_REMINDER_PREVIEW',
        }),
      );
    });
  });

  describe('sendReminder', () => {
    it('generates reminder and sends via outbound', async () => {
      const session = {
        sessionKey: 'sk-1',
        scheduledAt: new Date('2026-07-10T10:00:00Z'),
        topic: 'IELTS Writing',
        durationMinutes: 60,
      };

      const { service, studyReminder, outbound } = buildService();
      studyReminder.generateReminderBundleForSession.mockResolvedValue({
        text: 'Reminder text',
        output: {} as never,
      });

      const result = await service.sendReminder({
        psid: 'psid-1',
        userId: 10,
        session,
        messageType: 'STUDY_REMINDER',
      });

      expect(result).toBe('Reminder text');
      expect(
        studyReminder.generateReminderBundleForSession,
      ).toHaveBeenCalledWith('psid-1', session, {
        userId: 10,
        displayName: undefined,
      });
      expect(outbound.sendTextViaPsid).toHaveBeenCalledWith(
        expect.objectContaining({
          psid: 'psid-1',
          userId: 10,
          text: 'Reminder text',
          messageType: 'STUDY_REMINDER',
        }),
      );
    });
  });
});
