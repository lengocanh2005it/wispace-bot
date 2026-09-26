import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { UserEntity } from '@messenger/infrastructure/database/entities/user.entity';
import type {
  UserDisplayNameReaderPort,
  UserDisplayNameRecord,
} from '../../domain/user-display-name-reader.port';

/** Owns the `"Users"` view mapping; application policy sees plain records. */
@Injectable()
export class TypeormUserDisplayNameReader implements UserDisplayNameReaderPort {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
  ) {}

  async findByIds(userIds: number[]): Promise<UserDisplayNameRecord[]> {
    if (userIds.length === 0) return [];
    const users = await this.userRepo.find({
      where: { id: In(userIds) },
      select: { id: true, displayName: true, username: true },
    });
    return users.map((user) => ({
      id: user.id,
      displayName: user.displayName ?? null,
      username: user.username ?? null,
    }));
  }

  async findById(userId: number): Promise<UserDisplayNameRecord | null> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    return user
      ? {
          id: user.id,
          displayName: user.displayName ?? null,
          username: user.username ?? null,
        }
      : null;
  }
}
