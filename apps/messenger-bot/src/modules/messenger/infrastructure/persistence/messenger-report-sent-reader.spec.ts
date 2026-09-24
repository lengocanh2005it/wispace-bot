import { Repository } from 'typeorm';
import {
  LearnerScheduledReportClaimEntity,
  MessageLogEntity,
} from '@messenger/infrastructure/database/entities';
import { MessengerReportSentReader } from './messenger-report-sent-reader';

describe('MessengerReportSentReader', () => {
  const buildReader = (count = 0, learnerClaim: unknown = null) => {
    const builder = {} as {
      where: jest.Mock;
      andWhere: jest.Mock;
      getCount: jest.Mock;
    };
    builder.where = jest.fn().mockReturnValue(builder);
    builder.andWhere = jest.fn().mockReturnValue(builder);
    builder.getCount = jest.fn().mockResolvedValue(count);

    const logRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(builder),
    } as unknown as Repository<MessageLogEntity>;
    const learnerClaimRepo = {
      findOne: jest.fn().mockResolvedValue(learnerClaim),
    } as unknown as Repository<LearnerScheduledReportClaimEntity>;

    return {
      reader: new MessengerReportSentReader(
        logRepo,
        {
          get: jest.fn((key: string) =>
            key === 'CHAT_USAGE_TIMEZONE' ? 'America/New_York' : undefined,
          ),
        } as never,
        learnerClaimRepo,
      ),
      builder,
      logRepo,
      learnerClaimRepo,
    };
  };

  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses the canonical learner id and caller report date', async () => {
    const { reader, learnerClaimRepo, logRepo } = buildReader(0, {});

    await expect(
      reader.hasSentScheduledReportOn('psid-1', '2026-08-14', 143),
    ).resolves.toBe(true);

    expect(learnerClaimRepo.findOne).toHaveBeenCalledWith({
      where: {
        userId: 143,
        reportDate: '2026-08-14',
        reportType: 'scheduled',
        status: 'sent',
      },
    });
    expect(logRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('keeps the message-log fallback on the named report day in the configured timezone', async () => {
    const { reader, builder } = buildReader(1);

    await expect(
      reader.hasSentScheduledReportOn('psid-1', '2026-07-29', 143),
    ).resolves.toBe(true);

    expect(builder.andWhere).toHaveBeenCalledWith(
      'log.created_at >= :startOfDay',
      { startOfDay: new Date('2026-07-29T04:00:00.000Z') },
    );
    expect(builder.andWhere).toHaveBeenCalledWith(
      'log.created_at < :endOfDay',
      { endOfDay: new Date('2026-07-30T04:00:00.000Z') },
    );
  });

  it('checks the external identity when no learner id is available', async () => {
    const { reader, learnerClaimRepo, builder } = buildReader(0);

    await expect(
      reader.hasSentScheduledReportOn('psid-1', '2026-08-14'),
    ).resolves.toBe(false);

    expect(learnerClaimRepo.findOne).toHaveBeenCalledWith({
      where: {
        platform: 'messenger',
        externalUserId: 'psid-1',
        reportDate: '2026-08-14',
        reportType: 'scheduled',
        status: 'sent',
      },
    });
    expect(builder.getCount).toHaveBeenCalled();
  });
});
