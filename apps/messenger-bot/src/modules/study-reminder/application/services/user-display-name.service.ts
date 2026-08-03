import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { UserEntity } from '@messenger/infrastructure/database/entities/user.entity';
import { FALLBACK_DISPLAY_NAME } from '@messenger/shared/config/poc.constants';
import {
  MESSENGER_MAPPING_READER,
  type MessengerMappingReaderPort,
} from '@messenger/shared/ports/messenger-mapping-reader.port';
import {
  USER_DISPLAY_NAME_CACHE,
  type UserDisplayNameCachePort,
} from '../../domain/repositories/user-display-name-cache.port';

@Injectable()
export class UserDisplayNameService implements OnModuleInit {
  private readonly logger = new Logger(UserDisplayNameService.name);

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    @Inject(MESSENGER_MAPPING_READER)
    private readonly messengerMappingReader: MessengerMappingReaderPort,
    @Optional()
    @Inject(USER_DISPLAY_NAME_CACHE)
    private readonly displayNameCache?: UserDisplayNameCachePort,
  ) {}

  onModuleInit(): void {
    if (this.displayNameCache?.isAvailable()) {
      this.logger.log('User display name cache active=redis');
      return;
    }

    this.logger.log('User display name cache active=postgres (no redis cache)');
  }

  async preloadDisplayNames(userIds: number[]): Promise<void> {
    if (!userIds.length) return;

    const toFetch = this.displayNameCache?.isAvailable()
      ? await this.filterUncachedIds(userIds)
      : userIds;

    if (!toFetch.length) return;

    const users = await this.userRepo.find({
      where: { id: In(toFetch) },
      select: { id: true, displayName: true, username: true },
    });

    if (this.displayNameCache?.isAvailable()) {
      await Promise.all(
        users.map((u) =>
          this.displayNameCache!.set(u.id, {
            displayName: u.displayName ?? null,
            username: u.username ?? null,
          }),
        ),
      );
    }
  }

  private async filterUncachedIds(userIds: number[]): Promise<number[]> {
    const results = await Promise.all(
      userIds.map(async (userId) => ({
        userId,
        cached: await this.displayNameCache!.get(userId),
      })),
    );
    return results.filter((r) => !r.cached).map((r) => r.userId);
  }

  async resolveDisplayName(params: {
    userId?: number;
    psid?: string;
  }): Promise<string> {
    const userId = await this.resolveUserId(params);
    if (!userId) {
      return FALLBACK_DISPLAY_NAME;
    }

    if (this.displayNameCache?.isAvailable()) {
      const cached = await this.displayNameCache.get(userId);
      if (cached) {
        return this.pickDisplayName(
          cached.displayName,
          cached.username ?? null,
        );
      }
    }

    const user = await this.userRepo.findOne({ where: { id: userId } });
    const displayName = user?.displayName ?? null;
    const username = user?.username ?? null;

    if (this.displayNameCache?.isAvailable()) {
      await this.displayNameCache.set(userId, { displayName, username });
    }

    if (!user) {
      return FALLBACK_DISPLAY_NAME;
    }

    return this.pickDisplayName(displayName, username);
  }

  private pickDisplayName(
    displayName: string | null,
    username: string | null,
  ): string {
    const name = displayName?.trim();
    if (name) {
      return name;
    }

    const login = username?.trim();
    if (login) {
      return login;
    }

    return FALLBACK_DISPLAY_NAME;
  }

  private async resolveUserId(params: {
    userId?: number;
    psid?: string;
  }): Promise<number | undefined> {
    if (params.userId && params.userId > 0) {
      return params.userId;
    }

    if (!params.psid?.trim()) {
      return undefined;
    }

    const mapping = await this.messengerMappingReader.findActiveMappingByPsid(
      params.psid.trim(),
    );

    return mapping?.userId;
  }
}
