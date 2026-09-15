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
      reader: new MessengerReportSentReader(logRepo, learnerClaimRepo),
      builder,
      logRepo,
      learnerClaimRepo,
    };
  };

  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses the canonical learner id so a relinked PSID sees the same report date', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T06:30:00.000Z'));
    const { reader, learnerClaimRepo, logRepo } = buildReader(0, {});

    await expect(
      reader.hasSentScheduledReportToday('psid-1', 143),
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

  it('keeps the message-log fallback on the ICT midnight boundary (#968)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-13T23:30:00.000Z'));
    const { reader, builder } = buildReader(1);

    await expect(
      reader.hasSentScheduledReportToday('psid-1', 143),
    ).resolves.toBe(true);

    expect(builder.andWhere).toHaveBeenCalledWith(
      'log.created_at >= :startOfDay',
      { startOfDay: new Date('2026-08-13T17:00:00.000Z') },
    );
  });

  it('checks the external identity when no learner id is available', async () => {
    const { reader, learnerClaimRepo, builder } = buildReader(0);

    await expect(reader.hasSentScheduledReportToday('psid-1')).resolves.toBe(
      false,
    );

    expect(learnerClaimRepo.findOne).toHaveBeenCalledWith({
      where: {
        platform: 'messenger',
        externalUserId: 'psid-1',
        reportDate: expect.any(String),
        reportType: 'scheduled',
        status: 'sent',
      },
    });
    expect(builder.getCount).toHaveBeenCalled();
  });
});
