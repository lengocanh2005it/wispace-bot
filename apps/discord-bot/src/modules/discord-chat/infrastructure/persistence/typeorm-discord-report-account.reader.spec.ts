import { Repository } from 'typeorm';
import { TypeormDiscordReportAccountReader } from './typeorm-discord-report-account.reader';

describe('TypeormDiscordReportAccountReader — report consent gate (#596)', () => {
  let getMany: jest.Mock;
  let andWhereCalls: string[];
  let reader: TypeormDiscordReportAccountReader;

  const buildQb = () => {
    const qb = {
      leftJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn((cond: string) => {
        andWhereCalls.push(cond);
        return qb;
      }),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany,
    };
    return qb;
  };

  beforeEach(() => {
    getMany = jest.fn().mockResolvedValue([]);
    andWhereCalls = [];
    const createQueryBuilder = jest.fn(() => buildQb());
    const repo = { createQueryBuilder } as unknown as Repository<never>;
    reader = new TypeormDiscordReportAccountReader(repo);
  });

  it('filters to report-opted-in learners by default', async () => {
    await reader.findActiveAccountsPage(undefined, 200);

    expect(andWhereCalls).toContain(
      'COALESCE(pref.report_enabled, false) = true',
    );
  });

  it('passes the keyset cursor when provided', async () => {
    const qbCalls: unknown[][] = [];
    const createQueryBuilder = jest.fn(() => {
      const qb = {
        leftJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn((cond: string, params?: unknown) => {
          andWhereCalls.push(cond);
          qbCalls.push([cond, params]);
          return qb;
        }),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany,
      };
      return qb;
    });
    const repo = { createQueryBuilder } as unknown as Repository<never>;
    const localReader = new TypeormDiscordReportAccountReader(repo);

    await localReader.findActiveAccountsPage('55', 200);

    expect(andWhereCalls).toContain('link.id > :cursor');
  });

  it('forceSend (includeUnsubscribed) bypasses the consent gate', async () => {
    await reader.findActiveAccountsPage(undefined, 200, {
      includeUnsubscribed: true,
    });

    expect(andWhereCalls).not.toContain(
      'COALESCE(pref.report_enabled, false) = true',
    );
  });

  it('joins the consent table on user_id', async () => {
    const createQueryBuilder = jest.fn(() => {
      const qb = {
        leftJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany,
      };
      return qb;
    });
    const repo = { createQueryBuilder } as unknown as Repository<never>;
    const localReader = new TypeormDiscordReportAccountReader(repo);

    await localReader.findActiveAccountsPage(undefined, 200);

    const qb = createQueryBuilder.mock.results[0].value;
    expect(qb.leftJoin).toHaveBeenCalledWith(
      'user_notification_preferences',
      'pref',
      'pref.user_id = link.user_id',
    );
  });
});
