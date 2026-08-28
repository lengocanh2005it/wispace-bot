import {
  assertPostgresWriter,
  isPostgresWriter,
  POSTGRES_WRITER_CHECK_QUERY,
} from './postgres-writer';

describe('postgres writer checks', () => {
  it('uses pg_is_in_recovery and accepts a primary connection', async () => {
    const query = jest.fn().mockResolvedValue([{ in_recovery: false }]);

    await assertPostgresWriter({ query });

    expect(query).toHaveBeenCalledWith(POSTGRES_WRITER_CHECK_QUERY);
  });

  it('rejects a standby connection', async () => {
    const query = jest.fn().mockResolvedValue([{ in_recovery: true }]);

    await expect(assertPostgresWriter({ query })).rejects.toThrow(
      'not a writable primary',
    );
  });

  it('returns false when the database check fails', async () => {
    const query = jest.fn().mockRejectedValue(new Error('connection refused'));

    await expect(isPostgresWriter({ query })).resolves.toBe(false);
  });
});
