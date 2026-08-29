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
  ): Promise<ReportAccountRow[]> {
    return this.repo
      .createQueryBuilder('link')
      .select([
        'link.id',
        'link.externalUserId',
        'link.userId',
        'link.platform',
        'link.linkState',
      ])
      .where('link.platform = :platform', { platform: PLATFORM })
      .andWhere("COALESCE(link.link_state, 'active') = 'active'")
      .andWhere(cursor !== undefined ? 'link.id > :cursor' : 'TRUE', { cursor })
      .orderBy('link.id', 'ASC')
      .take(limit)
      .getMany();
  }
}
