import { TypeormRescheduleStore } from './typeorm-reschedule-store';

function mockRepo() {
  return {
    query: jest.fn().mockResolvedValue([[], 0]),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    delete: jest.fn(),
  };
}

describe('TypeormRescheduleStore', () => {
  describe('takeValid', () => {
    it('sets lease_token and processing_started_at alongside processing status', async () => {
      const repo = mockRepo();
      // Real driver shape: UPDATE … RETURNING returns [rows, rowCount].
      repo.query.mockResolvedValue([
        [
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
            lease_token: 'lease-uuid',
          },
        ],
        1,
      ]);
      const store = new TypeormRescheduleStore('messenger', repo as never);

      const result = await store.takeValid('psid1');

      const sql = repo.query.mock.calls[0][0] as string;
      expect(sql).toContain('lease_token = $2');
      expect(sql).toContain('processing_started_at = now()');
      expect(sql).toContain("'processing'");
      expect(result).not.toBeNull();
      expect(result?.externalId).toBe('psid1');
      expect(result?.leaseToken).toBe('lease-uuid');
    });

    it('returns null when no pending row matches (real [[], 0] tuple shape)', async () => {
      const repo = mockRepo();
      repo.query.mockResolvedValue([[], 0]);
      const store = new TypeormRescheduleStore('messenger', repo as never);

      const result = await store.takeValid('psid1');
      expect(result).toBeNull();
    });

    it('binds approval fields after the optional user id parameter', async () => {
      const repo = mockRepo();
      const store = new TypeormRescheduleStore('discord', repo as never);

      await store.takeValid('uid-1', 42, {
        platform: 'discord',
        mappingVersion: 'mapping-1',
        intentHash: 'intent-1',
        argsHash: 'args-1',
        nonce: '00000000-0000-4000-8000-000000000000',
      });

      const sql = repo.query.mock.calls[0][0] as string;
      expect(sql).toContain('platform = $4');
      expect(sql).toContain('mapping_version = $5');
      expect(sql).toContain('nonce = $8');
      expect(repo.query.mock.calls[0][1]).toEqual([
        'discord:uid-1',
        expect.any(String),
        42,
        'discord',
        'mapping-1',
        'intent-1',
        'args-1',
        '00000000-0000-4000-8000-000000000000',
      ]);
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

    it('includes lease_token guard when leaseToken provided', async () => {
      const repo = mockRepo();
      const store = new TypeormRescheduleStore('messenger', repo as never);

      await store.revertToPending('psid1', 'my-lease');

      const sql = repo.query.mock.calls[0][0] as string;
      expect(sql).toContain('lease_token = $2');
      const params = repo.query.mock.calls[0][1] as unknown[];
      expect(params).toContain('my-lease');
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

    it('includes lease_token guard when leaseToken provided', async () => {
      const repo = mockRepo();
      const store = new TypeormRescheduleStore('messenger', repo as never);

      await store.cancel('psid1', 'my-lease');

      const sql = repo.query.mock.calls[0][0] as string;
      expect(sql).toContain('lease_token = $2');
      const params = repo.query.mock.calls[0][1] as unknown[];
      expect(params).toContain('my-lease');
    });
  });

  describe('recoverStaleProcessing', () => {
    it('counts RETURNING 1 rows as the recovery count', async () => {
      const repo = mockRepo();
      repo.query.mockResolvedValue([[{ 1: 1 }, { 1: 1 }], 2]);
      const store = new TypeormRescheduleStore('messenger', repo as never);

      const recovered = await store.recoverStaleProcessing(300_000);

      const sql = repo.query.mock.calls[0][0] as string;
      expect(sql).toContain("status = 'pending'");
      expect(sql).toContain('processing_started_at <');
      expect(sql).toContain('lease_token IS NOT NULL');
      expect(sql).toContain('RETURNING 1');
      expect(recovered).toBe(2);
    });

    it('reports 0 when no stale processing rows matched ([[], 0] tuple)', async () => {
      const repo = mockRepo();
      repo.query.mockResolvedValue([[], 0]);
      const store = new TypeormRescheduleStore('messenger', repo as never);

      const recovered = await store.recoverStaleProcessing(300_000);
      expect(recovered).toBe(0);
    });
  });
});
