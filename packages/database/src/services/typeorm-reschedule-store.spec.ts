import { TypeormRescheduleStore } from './typeorm-reschedule-store';

function mockRepo() {
  return {
    query: jest.fn().mockResolvedValue([]),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    delete: jest.fn(),
  };
}

describe('TypeormRescheduleStore', () => {
  describe('takeValid', () => {
    it('sets lease_token and processing_started_at alongside processing status', async () => {
      const repo = mockRepo();
      repo.query.mockResolvedValue([
        {
          external_id: 'messenger:psid1',
          user_id: 1,
          calendar_id: 10,
          scheduling_mode: 'explicit',
          new_local_date: '2026-08-22',
          new_time: '14:00',
          session_label: 'Hôm nay 14:00',
          status: 'processing',
          expires_at: new Date(),
        },
      ]);
      const store = new TypeormRescheduleStore('messenger', repo as never);

      const result = await store.takeValid('psid1');

      const sql = repo.query.mock.calls[0][0] as string;
      expect(sql).toContain('lease_token = $2');
      expect(sql).toContain('processing_started_at = now()');
      expect(sql).toContain("'processing'");
      expect(result).not.toBeNull();
      expect(result?.externalId).toBe('psid1');
    });

    it('returns null when no pending row matches', async () => {
      const repo = mockRepo();
      repo.query.mockResolvedValue([]);
      const store = new TypeormRescheduleStore('messenger', repo as never);

      const result = await store.takeValid('psid1');
      expect(result).toBeNull();
    });
  });

  describe('revertToPending', () => {
    it('clears lease_token and processing_started_at on revert', async () => {
      const repo = mockRepo();
      const store = new TypeormRescheduleStore('messenger', repo as never);

      await store.revertToPending('psid1');

      const sql = repo.query.mock.calls[0][0] as string;
      expect(sql).toContain('lease_token = NULL');
      expect(sql).toContain('processing_started_at = NULL');
      expect(sql).toContain("'pending'");
    });
  });

  describe('cancel', () => {
    it('deletes rows with null lease or non-processing status', async () => {
      const repo = mockRepo();
      const store = new TypeormRescheduleStore('messenger', repo as never);

      await store.cancel('psid1');

      const sql = repo.query.mock.calls[0][0] as string;
      expect(sql).toContain('DELETE FROM');
      expect(sql).toContain('lease_token IS NULL');
    });
  });

  describe('recoverStaleProcessing', () => {
    it('resets expired processing rows to pending', async () => {
      const repo = mockRepo();
      repo.query.mockResolvedValue([{ affected: 2 }]);
      const store = new TypeormRescheduleStore('messenger', repo as never);

      const recovered = await store.recoverStaleProcessing('pod-1', 300_000);

      const sql = repo.query.mock.calls[0][0] as string;
      expect(sql).toContain("status = 'pending'");
      expect(sql).toContain('processing_started_at <');
      expect(sql).toContain('lease_token IS NOT NULL');
      expect(recovered).toBe(2);
    });

    it('does not touch fresh processing rows', async () => {
      const repo = mockRepo();
      repo.query.mockResolvedValue([{ affected: 0 }]);
      const store = new TypeormRescheduleStore('messenger', repo as never);

      const recovered = await store.recoverStaleProcessing('pod-1', 300_000);
      expect(recovered).toBe(0);
    });
  });
});
