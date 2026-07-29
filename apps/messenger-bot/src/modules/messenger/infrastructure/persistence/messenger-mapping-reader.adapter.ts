import { Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { MESSENGER_REPOSITORY } from '../../domain/repositories/messenger.repository.port';
import type { MessengerRepositoryPort } from '../../domain/repositories/messenger.repository.port';
import type {
  MessengerMappingReaderPort,
  UserLink,
} from '@messenger/shared/ports/messenger-mapping-reader.port';

/**
 * Adapts MessengerRepositoryPort (returns full UserMessengerMapping)
 * to MessengerMappingReaderPort (returns lightweight UserLink DTO).
 * Breaks the cross-module entity leak from study-reminder → messenger domain.
 */
@Injectable()
export class MessengerMappingReaderAdapter implements MessengerMappingReaderPort {
  constructor(
    @Inject(MESSENGER_REPOSITORY)
    private readonly repository: MessengerRepositoryPort,
  ) {}

  async findActiveMappingByPsid(psid: string): Promise<UserLink | null> {
    const mapping = await this.repository.findActiveMappingByPsid(psid);
    return mapping ? this.toUserLink(mapping) : null;
  }

  async findActiveMappingByUserId(userId: number): Promise<UserLink | null> {
    const mapping = await this.repository.findActiveMappingByUserId(userId);
    return mapping ? this.toUserLink(mapping) : null;
  }

  async findActiveMappingsWithPsid(): Promise<UserLink[]> {
    const mappings = await this.repository.findActiveMappingsWithPsid();
    return mappings.map((m) => this.toUserLink(m));
  }

  private toUserLink(mapping: {
    psid?: string;
    userId?: number;
    cadence?: string;
    topic?: string;
  }): UserLink {
    return {
      psid: mapping.psid,
      userId: mapping.userId,
      cadence: mapping.cadence as UserLink['cadence'],
      topic: mapping.topic,
    };
  }
}
