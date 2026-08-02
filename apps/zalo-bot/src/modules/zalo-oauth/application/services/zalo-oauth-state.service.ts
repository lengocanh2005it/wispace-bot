import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { Repository } from 'typeorm';
import { ZaloOauthStateEntity } from '@zalo/infrastructure/database/entities/zalo-oauth-state.entity';

const STATE_TTL_MS = 10 * 60 * 1000;

export interface ConsumedZaloOauthState {
  codeVerifier: string;
  linkToken: string;
}

/**
 * PKCE code_verifier staging between GET /zalo/oauth/authorize and
 * GET /zalo/oauth/callback (spec §5.2). TTL enforced in application code —
 * see docs/superpowers/specs/2026-07-20-zalo-bot-mvp-design.md §11.8 for
 * the future cleanup-cron follow-up.
 */
@Injectable()
export class ZaloOauthStateService {
  constructor(
    @InjectRepository(ZaloOauthStateEntity)
    private readonly repo: Repository<ZaloOauthStateEntity>,
  ) {}

  async create(codeVerifier: string, linkToken: string): Promise<string> {
    const state = randomBytes(24).toString('hex');
    await this.repo.save({
      state,
      codeVerifier,
      linkToken,
      createdAt: new Date(),
    });
    return state;
  }

  /** Deletes the row regardless of outcome (single-use, even if expired). */
  async consume(state: string): Promise<ConsumedZaloOauthState | undefined> {
    const row = await this.repo.findOne({ where: { state } });
    if (!row) {
      return undefined;
    }

    await this.repo.delete({ state });

    const isExpired = Date.now() - row.createdAt.getTime() > STATE_TTL_MS;
    return isExpired
      ? undefined
      : { codeVerifier: row.codeVerifier, linkToken: row.linkToken };
  }
}
