import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DiscordAccountLinkEntity } from '@discord/infrastructure/database/entities/discord-account-link.entity';
import type {
  DiscordReportAccountPageReaderPort,
  ReportAccountRow,
} from '../../domain/ports/discord-report-account-reader.port';

const PLATFORM = 'discord' as const;

/** TypeORM keyset-paged reader for the daily report cron. */
@Injectable()
export class TypeormDiscordReportAccountReader implements DiscordReportAccountPageReaderPort {
  constructor(
    @InjectRepository(DiscordAccountLinkEntity)
    private readonly repo: Repository<DiscordAccountLinkEntity>,
  ) {}

  async findActiveAccountsPage(
    cursor: string | undefined,
    limit: number,
    options?: { includeUnsubscribed?: boolean },
  ): Promise<ReportAccountRow[]> {
    const qb = this.repo
      .createQueryBuilder('link')
      .leftJoin(
        'user_notification_preferences',
        'pref',
        'pref.user_id = link.user_id',
      )
      .select([
        'link.id',
        'link.externalUserId',
        'link.userId',
        'link.platform',
        'link.linkState',
        'link.optoutNoticeSentAt',
      ])
      .where('link.platform = :platform', { platform: PLATFORM })
      .andWhere("COALESCE(link.link_state, 'active') = 'active'")
      .andWhere(cursor !== undefined ? 'link.id > :cursor' : 'TRUE', { cursor })
      .orderBy('link.id', 'ASC')
      .take(limit);
    if (options?.includeUnsubscribed !== true) {
      // Reports are opt-in (#596): NULL consent row = not opted in.
      // forceSend (ops override) skips this gate.
      qb.andWhere('COALESCE(pref.report_enabled, false) = true');
    }
    return qb.getMany();
  }

  async findLinkStateByExternalUserId(externalUserId: string): Promise<{
    id: string;
    userId: number | null;
    linkState: string | null;
  } | null> {
    const link = await this.repo.findOne({
      where: { platform: PLATFORM, externalUserId },
      select: { id: true, userId: true, linkState: true },
    });
    if (!link) return null;
    return { id: link.id, userId: link.userId, linkState: link.linkState };
  }

  async markOptOutNoticeSent(id: string): Promise<void> {
    await this.repo.update({ id }, { optoutNoticeSentAt: new Date() });
  }
}
