import {
  LinkCompletionCore,
  LinkReconcileCronCore,
  LinkTokenRejectedError,
  type LinkCompletionAfterCommitResult,
  type LinkFlowAdapter,
  type VerifyIntentRecord,
} from './account-link.core';

const identity = { externalUserId: 'external-1', displayName: 'Learner' };

function completionPorts(
  overrides: Partial<LinkFlowAdapter<void>> = {},
): LinkFlowAdapter<void> {
  return {
    exchange: async () => identity,
    verifyToken: async () => ({ valid: true, userId: 42 }),
    recordVerify: async () => undefined,
    upsertLink: async () => ({ relinked: false }),
    consumeRecord: async () => undefined,
    ...overrides,
  };
}

describe('LinkCompletionCore', () => {
  it('persists the intent before mapping and consumes it before side effects', async () => {
    const calls: string[] = [];
    let afterCommit: LinkCompletionAfterCommitResult | undefined;
    const core = new LinkCompletionCore(
      completionPorts({
        recordVerify: async () => calls.push('record'),
        upsertLink: async () => {
          calls.push('upsert');
          return { relinked: true, previousUserId: 7 };
        },
        consumeRecord: async () => calls.push('consume'),
        afterCommit: async () => {
          calls.push('side-effects');
          afterCommit = { nextAction: 'join-community' };
          return afterCommit;
        },
      }),
    );

    await expect(
      core.complete({ input: undefined, linkToken: 'token' }),
    ).resolves.toEqual({
      status: 'linked',
      nextAction: 'join-community',
    });
    expect(calls).toEqual(['record', 'upsert', 'consume', 'side-effects']);
  });

  it('rejects a token without writing an intent or mapping', async () => {
    const recordVerify = jest.fn();
    const upsertLink = jest.fn();
    const core = new LinkCompletionCore(
      completionPorts({
        verifyToken: async () => ({ valid: false }),
        recordVerify,
        upsertLink,
      }),
    );

    await expect(
      core.complete({ input: undefined, linkToken: 'bad' }),
    ).rejects.toBeInstanceOf(LinkTokenRejectedError);
    expect(recordVerify).not.toHaveBeenCalled();
    expect(upsertLink).not.toHaveBeenCalled();
  });

  it('retries durable intent writes with bounded jitter and never maps after exhaustion', async () => {
    const recordVerify = jest
      .fn<Promise<void>, []>()
      .mockRejectedValue(new Error('temporary'));
    const upsertLink = jest.fn();
    const delays: number[] = [];
    const core = new LinkCompletionCore(
      completionPorts({ recordVerify, upsertLink }),
      {
        retry: {
          maxAttempts: 3,
          baseDelayMs: 10,
          rng: () => 0,
          sleep: async (ms) => delays.push(ms),
        },
      },
    );

    await expect(
      core.complete({ input: undefined, linkToken: 'token' }),
    ).rejects.toThrow('temporary');
    expect(recordVerify).toHaveBeenCalledTimes(3);
    expect(upsertLink).not.toHaveBeenCalled();
    expect(delays).toEqual([5, 10]);
  });

  it('keeps consume and side-effect failures best effort after the mapping commits', async () => {
    const errors: string[] = [];
    const core = new LinkCompletionCore(
      completionPorts({
        consumeRecord: async () => {
          throw new Error('consume failed');
        },
        afterCommit: async () => {
          throw new Error('welcome failed');
        },
      }),
      { onBestEffortError: (step) => errors.push(step) },
    );

    await expect(
      core.complete({ input: undefined, linkToken: 'token' }),
    ).resolves.toEqual({
      status: 'linked',
    });
    expect(errors).toEqual(['consume', 'after-commit']);
  });
});

describe('LinkReconcileCronCore', () => {
  function record(
    overrides: Partial<VerifyIntentRecord> = {},
  ): VerifyIntentRecord {
    return {
      externalUserId: 'external-1',
      userId: 42,
      verifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides,
    };
  }

  it('reconciles records independently and preserves mismatches', async () => {
    const consumed: string[] = [];
    const upserts: string[] = [];
    const records = [
      record(),
      record({ externalUserId: 'mismatch', userId: 9 }),
      record({ externalUserId: 'error', userId: 10 }),
    ];
    const core = new LinkReconcileCronCore({
      listStaleRecords: async () => records,
      findUserId: async (externalUserId) =>
        externalUserId === 'mismatch' ? 7 : undefined,
      upsertLink: async (userId, externalUserId) => {
        if (externalUserId === 'error') throw new Error('upsert failed');
        upserts.push(`${userId}:${externalUserId}`);
        return { relinked: false };
      },
      consumeRecord: async (externalUserId) => consumed.push(externalUserId),
    });

    await expect(
      core.runBatch({
        staleAgeMs: 1,
        maxRecordAgeMs: 60 * 60 * 1000,
        now: () => new Date('2026-01-01T00:05:00.000Z'),
      }),
    ).resolves.toMatchObject({
      records: 3,
      reconciled: 1,
      mismatched: 1,
      failed: 1,
    });
    expect(upserts).toEqual(['42:external-1']);
    expect(consumed).toEqual(['external-1']);
  });

  it('drops stale records and does not overwrite a guarded link state', async () => {
    const consumed: string[] = [];
    const upsertLink = jest.fn();
    const core = new LinkReconcileCronCore({
      listStaleRecords: async () => [
        record(),
        record({ externalUserId: 'revoked' }),
      ],
      findUserId: async () => undefined,
      getLinkState: async (externalUserId) =>
        externalUserId === 'revoked'
          ? { state: 'confirmed-revoked' }
          : undefined,
      upsertLink,
      consumeRecord: async (externalUserId) => consumed.push(externalUserId),
    });

    await core.runBatch({
      staleAgeMs: 1,
      maxRecordAgeMs: 60 * 1000,
      now: () => new Date('2026-01-01T00:05:00.000Z'),
    });
    expect(upsertLink).not.toHaveBeenCalled();
    expect(consumed).toEqual(['external-1', 'revoked']);
  });
});
