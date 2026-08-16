import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LearnerProfileEntity } from '@wispace/database';
import { Repository } from 'typeorm';
import type { LearnerProfileStorePort } from './learner-profile.store.port';
import type { LearnerFacts, LearnerProfile } from './types';

function toProfile(row: LearnerProfileEntity): LearnerProfile {
  return {
    platform: row.platform,
    externalUserId: row.externalUserId,
    userId: row.userId,
    targetScore: row.targetScore ?? undefined,
    targetScoreFetchedAt: row.targetScoreFetchedAt ?? undefined,
    examDate: row.examDate ?? undefined,
    examDateFetchedAt: row.examDateFetchedAt ?? undefined,
  };
}

/**
 * TypeORM-backed learner profile store (shared `learner_profiles` table).
 * Upsert relies on TypeORM `save()` with the composite primary key — columns
 * left undefined are omitted from the UPDATE, giving partial-merge semantics.
 */
@Injectable()
export class TypeOrmLearnerProfileStore implements LearnerProfileStorePort {
  constructor(
    @InjectRepository(LearnerProfileEntity)
    private readonly repo: Repository<LearnerProfileEntity>,
  ) {}

  async get(
    platform: string,
    externalUserId: string,
  ): Promise<LearnerProfile | null> {
    const row = await this.repo.findOne({
      where: { platform, externalUserId },
    });
    return row ? toProfile(row) : null;
  }

  async upsert(
    platform: string,
    externalUserId: string,
    userId: number | undefined,
    facts: LearnerFacts,
  ): Promise<void> {
    const row = this.repo.create({
      platform,
      externalUserId,
      userId: userId ?? null,
      updatedAt: new Date(),
      ...facts,
    });
    await this.repo.save(row);
  }
}
