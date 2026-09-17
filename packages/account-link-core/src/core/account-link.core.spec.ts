import {
  LinkCompletionCore,
  LinkConflictError,
  LinkPersistenceExhaustedError,
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
    getMappingObservation: async () => ({ kind: 'absent' }),
    verifyToken: async () => ({ valid: true, userId: 42 }),
    recordVerify: async () => ({ intentGeneration: '1' }),
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
        recordVerify: async () => {
          calls.push('record');
          return { intentGeneration: '1' };
        },
        upsertLink: async () => {
          calls.push('upsert');
          return { relinked: true, previousUserId: 7 };
        },
        consumeRecord: async () => {
          calls.push('consume');
        },
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

  it('persists and reuses the original mapping observation and intent generation', async () => {
    const observation = { kind: 'absent' } as const;
    const recordVerify = jest.fn().mockResolvedValue({ intentGeneration: '2' });
    const upsertLink = jest.fn().mockResolvedValue({ relinked: false });
    const consumeRecord = jest.fn().mockResolvedValue(true);
    const core = new LinkCompletionCore({
      exchange: async () => identity,
      getMappingObservation: async () => observation,
      verifyToken: async () => ({ valid: true, userId: 42 }),
      recordVerify,
      upsertLink,
      consumeRecord,
    } as never);

    await core.complete({ input: undefined, linkToken: 'token' });

    expect(recordVerify).toHaveBeenCalledWith('external-1', 42, observation);
    expect(upsertLink).toHaveBeenCalledWith(42, 'external-1', observation);
    expect(consumeRecord).toHaveBeenCalledWith({
      externalUserId: 'external-1',
      userId: 42,
      intentGeneration: '2',
    });
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
    const recordVerify = jest.fn().mockRejectedValue(new Error('temporary'));
    const upsertLink = jest.fn();
    const delays: number[] = [];
    const core = new LinkCompletionCore(
      completionPorts({ recordVerify, upsertLink }),
      {
        retry: {
          maxAttempts: 3,
          baseDelayMs: 10,
          rng: () => 0,
          sleep: async (ms) => {
            delays.push(ms);
          },
        },
      },
    );

    await expect(
      core.complete({ input: undefined, linkToken: 'token' }),
    ).rejects.toBeInstanceOf(LinkPersistenceExhaustedError);
    expect(recordVerify).toHaveBeenCalledTimes(3);
    expect(upsertLink).not.toHaveBeenCalled();
    expect(delays).toEqual([5, 10]);
  });

  it('types mapping persistence exhaustion and keeps the intent for reconcile', async () => {
    const upsertLink = jest.fn().mockRejectedValue(new Error('database down'));
    const consumeRecord = jest.fn();
    const core = new LinkCompletionCore(
      completionPorts({ upsertLink, consumeRecord }),
      { retry: { maxAttempts: 2, sleep: async () => undefined } },
    );

    await expect(
      core.complete({ input: undefined, linkToken: 'token' }),
    ).rejects.toBeInstanceOf(LinkPersistenceExhaustedError);
    expect(upsertLink).toHaveBeenCalledTimes(2);
    expect(consumeRecord).not.toHaveBeenCalled();
  });

  it('retries an ambiguous mapping write and treats the committed row as success', async () => {
    let committed = false;
    const upsertLink = jest.fn(async () => {
      if (!committed) {
        committed = true;
        throw new Error('response timeout after commit');
      }
      return { relinked: false };
    });
    const afterCommit = jest.fn();
    const core = new LinkCompletionCore(
      completionPorts({ upsertLink, afterCommit }),
      { retry: { maxAttempts: 2, sleep: async () => undefined } },
    );

    await expect(
      core.complete({ input: undefined, linkToken: 'token' }),
    ).resolves.toEqual({ status: 'linked' });
    expect(upsertLink).toHaveBeenCalledTimes(2);
    expect(afterCommit).toHaveBeenCalledTimes(1);
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

  it('retires a losing intent without running post-commit effects', async () => {
    const conflict = new Error('ownership changed');
    conflict.name = 'DiscordLinkOwnershipConflictError';
    const consumeRecord = jest.fn().mockResolvedValue(undefined);
    const afterCommit = jest.fn();
    const core = new LinkCompletionCore(
      completionPorts({
        upsertLink: jest.fn().mockRejectedValue(conflict),
        consumeRecord,
        afterCommit,
      }),
      { retry: { sleep: async () => undefined } },
    );

    await expect(
      core.complete({ input: undefined, linkToken: 'token' }),
    ).rejects.toBeInstanceOf(LinkConflictError);
    expect(consumeRecord).toHaveBeenCalledWith({
      externalUserId: 'external-1',
      userId: 42,
      intentGeneration: '1',
    });
    expect(afterCommit).not.toHaveBeenCalled();
  });

  it('lets only the first concurrent absent-observation callback commit', async () => {
    let observed = 0;
    let releaseBoth: (() => void) | undefined;
    const bothObserved = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    let mappingUserId: number | undefined;
    let intentGeneration = 0;
    const afterCommit = jest.fn();
    const ports = (userId: number): LinkFlowAdapter<string> => ({
      exchange: async () => identity,
      getMappingObservation: async () => {
        observed += 1;
        if (observed === 2) releaseBoth?.();
        else await bothObserved;
        return { kind: 'absent' };
      },
      verifyToken: async () => ({ valid: true, userId }),
      recordVerify: async () => ({
        intentGeneration: String(++intentGeneration),
      }),
      upsertLink: async () => {
        if (mappingUserId !== undefined) {
          const conflict = new Error('ownership changed');
          conflict.name = 'ZaloLinkOwnershipConflictError';
          throw conflict;
        }
        mappingUserId = userId;
        return { relinked: false };
      },
      consumeRecord: async () => undefined,
      afterCommit,
    });

    const outcomes = await Promise.allSettled([
      new LinkCompletionCore(ports(41)).complete({
        input: 'callback-a',
        linkToken: 'token-a',
      }),
      new LinkCompletionCore(ports(42)).complete({
        input: 'callback-b',
        linkToken: 'token-b',
      }),
    ]);

    expect(
      outcomes.filter(({ status }) => status === 'fulfilled'),
    ).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
    const rejected = outcomes.find(({ status }) => status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.any(LinkConflictError),
    });
    expect([41, 42]).toContain(mappingUserId);
    expect(afterCommit).toHaveBeenCalledTimes(1);
  });
});

describe('LinkReconcileCronCore', () => {
  function record(
    overrides: Partial<VerifyIntentRecord> = {},
  ): VerifyIntentRecord {
    return {
      externalUserId: 'external-1',
      userId: 42,
      intentGeneration: '1',
      verifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      mappingObservation: { kind: 'absent' },
      ...overrides,
    };
  }

  it('reconciles records independently and retires ownership conflicts', async () => {
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
        if (externalUserId === 'mismatch') {
          const conflict = new Error('ownership changed');
          conflict.name = 'DiscordLinkOwnershipConflictError';
          throw conflict;
        }
        upserts.push(`${userId}:${externalUserId}`);
        return { relinked: false };
      },
      consumeRecord: async (intent) => {
        consumed.push(intent.externalUserId);
      },
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
    expect(consumed).toEqual(['external-1', 'mismatch']);
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
      consumeRecord: async (intent) => {
        consumed.push(intent.externalUserId);
      },
    });

    await core.runBatch({
      staleAgeMs: 1,
      maxRecordAgeMs: 60 * 1000,
      now: () => new Date('2026-01-01T00:05:00.000Z'),
    });
    expect(upsertLink).not.toHaveBeenCalled();
    expect(consumed).toEqual(['external-1', 'revoked']);
  });

  it('retires an intent whose original mapping observation lost the race', async () => {
    const staleIntent = record();
    const conflict = new Error('ownership changed');
    conflict.name = 'ZaloLinkOwnershipConflictError';
    const upsertLink = jest.fn().mockRejectedValue(conflict);
    const consumeRecord = jest.fn().mockResolvedValue(true);
    const onReconciled = jest.fn();
    const core = new LinkReconcileCronCore({
      listStaleRecords: async () => [staleIntent],
      findUserId: async () => 7,
      upsertLink,
      consumeRecord,
    });

    await expect(
      core.runBatch({
        staleAgeMs: 1,
        maxRecordAgeMs: 60 * 60 * 1000,
        now: () => new Date('2026-01-01T00:05:00.000Z'),
        onReconciled,
      }),
    ).resolves.toMatchObject({ mismatched: 1, reconciled: 0 });
    expect(upsertLink).toHaveBeenCalledWith(
      42,
      'external-1',
      staleIntent.mappingObservation,
    );
    expect(consumeRecord).toHaveBeenCalledWith(staleIntent);
    expect(onReconciled).not.toHaveBeenCalled();
  });
});
