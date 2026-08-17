import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DiscordWelcomeRecordEntity } from '@discord/infrastructure/database/entities/discord-welcome-record.entity';
import type {
  DiscordWelcomeRecordRepositoryPort,
  WelcomeSource,
} from '../../domain/ports/discord-welcome-record.repository.port';

/** TypeORM implementation of `DiscordWelcomeRecordRepositoryPort`. */
@Injectable()
export class TypeormDiscordWelcomeRecordRepository implements DiscordWelcomeRecordRepositoryPort {
  constructor(
    @InjectRepository(DiscordWelcomeRecordEntity)
    private readonly repo: Repository<DiscordWelcomeRecordEntity>,
  ) {}

  async shouldWelcome(
    discordUserId: string,
    windowMs: number,
  ): Promise<boolean> {
    const row = await this.repo.findOne({
      where: { discordUserId },
      select: { lastWelcomedAt: true },
    });

    if (!row?.lastWelcomedAt) {
      return true;
    }

    return Date.now() - row.lastWelcomedAt.getTime() >= windowMs;
  }

  async markWelcomed(
    discordUserId: string,
    source: WelcomeSource,
  ): Promise<void> {
    await this.repo.upsert(
      { discordUserId, lastWelcomedAt: new Date(), source },
      ['discordUserId'],
    );
  }
}
