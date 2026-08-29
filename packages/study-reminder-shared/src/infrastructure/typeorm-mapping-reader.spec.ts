import { Repository } from 'typeorm';
import { TypeormMappingReader } from './typeorm-mapping-reader';

describe('TypeormMappingReader — reminder consent filter (#596)', () => {
  let query: jest.Mock;
  let findOne: jest.Mock;
  let reader: TypeormMappingReader;

  beforeEach(() => {
    query = jest.fn().mockResolvedValue([]);
    findOne = jest.fn().mockResolvedValue(null);
    const repo = { query, findOne } as unknown as Repository<unknown>;
    reader = new TypeormMappingReader(repo, 'discord_account_links');
  });

  describe('findActiveMappingsPage', () => {
    it('joins the consent table and keeps opt-out reminders on by default', async () => {
      query.mockResolvedValueOnce([
        {
          id: 2,
          externalUserId: 'discord-1',
          userId: 42,
          platform: 'discord',
        },
      ]);

      const page = await reader.findActiveMappingsPage('discord', {
        afterId: '0',
        limit: 100,
      });

      const [sql] = query.mock.calls[0];
      expect(String(sql)).toContain(
        'LEFT JOIN user_notification_preferences pref ON pref.user_id = m.user_id',
      );
      expect(String(sql)).toContain(
        `COALESCE(pref.reminder_enabled, true) = true`,
      );
      expect(String(sql)).toContain(`FROM discord_account_links m`);
      expect(page.items).toEqual([
        {
          externalUserId: 'discord-1',
          userId: 42,
          platform: 'discord',
        },
      ]);
      expect(page.nextId).toBe('2');
    });

    it('passes platform, keyset cursor and limit as parameters', async () => {
      await reader.findActiveMappingsPage('zalo', {
        afterId: '55',
        limit: 25,
      });

      expect(query.mock.calls[0][1]).toEqual(['zalo', '55', 25]);
    });
  });

  describe('findActiveMappingByExternalUserId', () => {
    const activeLink = {
      platform: 'discord',
      externalUserId: 'discord-1',
      userId: 42,
      linkState: 'active',
    };

    it('returns the link when reminder consent is default (NULL)', async () => {
      findOne.mockResolvedValueOnce(activeLink);
      query.mockResolvedValueOnce([{ reminder_enabled: null }]);

      const link = await reader.findActiveMappingByExternalUserId(
        'discord',
        'discord-1',
      );

      expect(link).not.toBeNull();
      expect(link?.userId).toBe(42);
    });

    it('returns the link when the learner explicitly opted in', async () => {
      findOne.mockResolvedValueOnce(activeLink);
      query.mockResolvedValueOnce([{ reminder_enabled: true }]);

      const link = await reader.findActiveMappingByExternalUserId(
        'discord',
        'discord-1',
      );

      expect(link).not.toBeNull();
    });

    it('returns null when the learner opted out of reminders', async () => {
      findOne.mockResolvedValueOnce(activeLink);
      query.mockResolvedValueOnce([{ reminder_enabled: false }]);

      const link = await reader.findActiveMappingByExternalUserId(
        'discord',
        'discord-1',
      );

      expect(link).toBeNull();
    });

    it('still returns null for a non-active link before any consent lookup', async () => {
      findOne.mockResolvedValueOnce({ ...activeLink, linkState: 'revoked' });

      const link = await reader.findActiveMappingByExternalUserId(
        'discord',
        'discord-1',
      );

      expect(link).toBeNull();
      expect(query).not.toHaveBeenCalled();
    });
  });
});
