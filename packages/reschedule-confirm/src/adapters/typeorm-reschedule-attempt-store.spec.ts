import { TypeormRescheduleAttemptStore } from './typeorm-reschedule-attempt-store';

/**
 * #1507: `reschedule_confirmation_attempts` is one table for all three bots
 * under one advisory lock. A scan without a platform predicate hands the
 * messenger transport a Discord id, which Meta rejects, burning the row's five
 * bounded attempts and abandoning a confirmation the learner never got.
 *
 * The predicate is asserted on the generated query because that is the only
 * place the regression can live; the memory store cannot reproduce it.
 */
function recordingRepo(rows: unknown[] = []) {
  const predicates: Array<[string, unknown]> = [];
  type Builder = {
    where: (sql: string, params?: Record<string, unknown>) => Builder;
    andWhere: (sql: string, params?: Record<string, unknown>) => Builder;
    orderBy: (column: string, direction: 'ASC' | 'DESC') => Builder;
    limit: (n: number) => Builder;
    getMany: () => Promise<unknown[]>;
    getOne: () => Promise<null>;
    insert: () => Builder;
    into: () => Builder;
    values: (v: Record<string, unknown>) => Builder;
    orUpdate: () => Builder;
    update: () => Builder;
    set: (v: Record<string, unknown>) => Builder;
    delete: () => Builder;
    from: () => Builder;
    execute: () => Promise<{ affected: number }>;
    valuesSpy: jest.Mock;
  };
  const builder: Builder = {
    valuesSpy: jest.fn(),
    where: (sql, params) => {
      predicates.push([sql, params]);
      return builder;
    },
    andWhere: (sql, params) => {
      predicates.push([sql, params]);
      return builder;
    },
    orderBy: () => builder,
    limit: () => builder,
    getMany: async () => rows,
    getOne: async () => null,
    insert: () => builder,
    into: () => builder,
    values: (v) => {
      builder.valuesSpy(v);
      return builder;
    },
    orUpdate: () => builder,
    update: () => builder,
    set: () => builder,
    delete: () => builder,
    from: () => builder,
    execute: async () => ({ affected: 1 }),
  };
  const repo = { createQueryBuilder: jest.fn(() => builder) };
  return { repo, predicates, builder };
}

describe('TypeormRescheduleAttemptStore platform scope (#1507)', () => {
  it('scopes the due-notification scan to the store platform', async () => {
    const { repo, predicates } = recordingRepo();

    await new TypeormRescheduleAttemptStore(
      'discord',
      repo as never,
    ).listDueNotificationAttempts(10, new Date());

    const platformPredicate = predicates.find(([sql]) =>
      sql.includes('platform = :platform'),
    );
    expect(platformPredicate).toBeDefined();
    expect(platformPredicate?.[1]).toEqual({ platform: 'discord' });
  });

  it('writes the bound platform rather than one supplied per call', async () => {
    const { repo, builder } = recordingRepo();

    await new TypeormRescheduleAttemptStore('zalo', repo as never).beginAttempt(
      { externalId: 'zalo-user-1', nonce: crypto.randomUUID(), userId: 7 },
    );

    // #1507: a caller-supplied platform could disagree with the store and put a
    // row in the wrong scan scope.
    expect(builder.valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'zalo' }),
    );
  });

  it('scopes findAttempt so another platform row is never read back', async () => {
    const { repo, predicates } = recordingRepo();

    await new TypeormRescheduleAttemptStore(
      'messenger',
      repo as never,
    ).findAttempt('psid-1', crypto.randomUUID());

    expect(
      predicates.filter(([sql]) => sql.includes('platform = :platform')),
    ).toHaveLength(1);
  });

  it('scopes clearAttempt so it cannot delete another platform row', async () => {
    const { repo, predicates } = recordingRepo();

    await new TypeormRescheduleAttemptStore(
      'discord',
      repo as never,
    ).clearAttempt('discord-user-1', crypto.randomUUID());

    expect(
      predicates.filter(([sql]) => sql.includes('platform = :platform')),
    ).toHaveLength(1);
  });

  it('scopes confirmAttempt so it cannot confirm another platform row', async () => {
    const { repo, predicates } = recordingRepo();

    await new TypeormRescheduleAttemptStore(
      'discord',
      repo as never,
    ).confirmAttempt({
      externalId: 'discord-user-1',
      nonce: crypto.randomUUID(),
      scheduledTimeLabel: '20/09 lúc 19:00',
    });

    expect(
      predicates.filter(([sql]) => sql.includes('platform = :platform')),
    ).toHaveLength(1);
  });
});
