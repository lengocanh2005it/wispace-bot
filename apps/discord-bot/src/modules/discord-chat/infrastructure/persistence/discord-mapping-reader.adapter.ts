import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type {
  MappingReaderPort,
  UserLink,
} from '@wispace/study-reminder-shared';
import { DiscordAccountLinkEntity } from '@discord/infrastructure/database/entities/discord-account-link.entity';

@Injectable()
export class DiscordMappingReaderAdapter implements MappingReaderPort {
  constructor(
    @InjectRepository(DiscordAccountLinkEntity)
    private readonly repo: Repository<DiscordAccountLinkEntity>,
  ) {}

  async findActiveMappings(platform: string): Promise<UserLink[]> {
    const links = await this.repo.find({
      where: { platform },
    });
    return links.map((link) => ({
      externalUserId: link.externalUserId,
      userId: link.userId,
      platform: link.platform,
    }));
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
