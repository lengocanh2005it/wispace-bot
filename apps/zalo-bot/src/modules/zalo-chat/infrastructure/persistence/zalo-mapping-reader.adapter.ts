import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type {
  MappingReaderPort,
  UserLink,
} from '@wispace/study-reminder-shared';
import { ZaloAccountLinkEntity } from '@zalo/infrastructure/database/entities/zalo-account-link.entity';

/**
 * Reads Zalo account links as user mappings for study reminder sync.
 */
@Injectable()
export class ZaloMappingReaderAdapter implements MappingReaderPort {
  constructor(
    @InjectRepository(ZaloAccountLinkEntity)
    private readonly repo: Repository<ZaloAccountLinkEntity>,
  ) {}

  async findActiveMappings(platform: string): Promise<UserLink[]> {
    const results = await this.repo.query<UserLink[]>(
      'SELECT external_user_id as "externalUserId", user_id as "userId", platform FROM zalo_account_links WHERE platform = $1',
      [platform],
    );
    return results;
  }

  async findActiveMappingByExternalUserId(
    platform: string,
    externalUserId: string,
  ): Promise<UserLink | null> {
    const link = await this.repo.findOne({
      where: { platform, externalUserId },
    });
    if (!link) return null;
    return {
      externalUserId: link.externalUserId,
      userId: link.userId,
      platform: link.platform,
    };
  }
}
