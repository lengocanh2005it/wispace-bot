/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest.fn() mock of global.fetch */
import { UserCalendarApiClient } from './user-calendar-api.client';

function buildBodyMock(text: string) {
  const bytes = new TextEncoder().encode(text);
  let read = false;
  return {
    body: {
      getReader: () => ({
        read: jest.fn().mockImplementation(() => {
          if (read) return Promise.resolve({ done: true, value: undefined });
          read = true;
          return Promise.resolve({ done: false, value: bytes });
        }),
        cancel: jest.fn(),
        releaseLock: jest.fn(),
      }),
    },
  };
}

const VALID_CALENDAR_RECORD = {
  id: 1,
  eventDate: '2026-09-01',
  time: '08:00',
  userId: 10,
};

describe('UserCalendarApiClient', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe('listCalendars', () => {
    it('fetches calendar records within 64KB array limit', async () => {
      const data = [
        VALID_CALENDAR_RECORD,
        { id: 2, eventDate: '2026-09-02', time: '09:00', userId: 10 },
      ];
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        ...buildBodyMock(JSON.stringify(data)),
        json: () => Promise.resolve(data),
      });
      global.fetch = fetchMock;

      const client = new UserCalendarApiClient({
        url: 'https://backend.example.com/api/UserCalendar',
        internalKey: 'internal-key',
      });

      const result = await client.listCalendars('x-psid', 'psid-1');
      expect(result).toHaveLength(2);
    });

    it('rejects array response exceeding 64KB limit', async () => {
      const oversized = Array.from({ length: 100 }, (_, i) => ({
        id: i,
        eventDate: 'x'.repeat(1024),
        time: '08:00',
        userId: 10,
      }));
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        ...buildBodyMock(JSON.stringify(oversized)),
        json: () => Promise.resolve(oversized),
      });
      global.fetch = fetchMock;

      const client = new UserCalendarApiClient({
        url: 'https://backend.example.com/api/UserCalendar',
        internalKey: 'internal-key',
      });

      await expect(client.listCalendars('x-psid', 'psid-1')).rejects.toThrow();
    });

    it('handles { data: [] } wrapper response', async () => {
      const data = { data: [VALID_CALENDAR_RECORD] };
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        ...buildBodyMock(JSON.stringify(data)),
        json: () => Promise.resolve(data),
      });
      global.fetch = fetchMock;

      const client = new UserCalendarApiClient({
        url: 'https://backend.example.com/api/UserCalendar',
        internalKey: 'internal-key',
      });

      const result = await client.listCalendars('x-psid', 'psid-1');
      expect(result).toHaveLength(1);
    });
  });

  describe('createCalendar', () => {
    it('creates a calendar record within 16KB limit', async () => {
      const created = {
        id: 1,
        eventDate: '2026-09-01',
        time: '08:00',
        userId: 10,
      };
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(created),
      });
      global.fetch = fetchMock;

      const client = new UserCalendarApiClient({
        url: 'https://backend.example.com/api/UserCalendar',
        internalKey: 'internal-key',
      });

      const result = await client.createCalendar('x-psid', 'psid-1', {
        eventDate: '2026-09-01',
        time: '08:00',
      });
      expect(result.id).toBe(1);
    });

    it('rejects oversized create response', async () => {
      const oversized = { id: 1, data: 'x'.repeat(20 * 1024) };
      const text = JSON.stringify(oversized);
      const bytes = new TextEncoder().encode(text);
      let read = false;
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        body: {
          getReader: () => ({
            read: jest.fn().mockImplementation(() => {
              if (read)
                return Promise.resolve({ done: true, value: undefined });
              read = true;
              return Promise.resolve({ done: false, value: bytes });
            }),
            cancel: jest.fn(),
            releaseLock: jest.fn(),
          }),
        },
        json: () => Promise.resolve(oversized),
      });
      global.fetch = fetchMock;

      const client = new UserCalendarApiClient({
        url: 'https://backend.example.com/api/UserCalendar',
        internalKey: 'internal-key',
      });

      await expect(
        client.createCalendar('x-psid', 'psid-1', {
          eventDate: '2026-09-01',
          time: '08:00',
        }),
      ).rejects.toThrow();
    });
  });
});
