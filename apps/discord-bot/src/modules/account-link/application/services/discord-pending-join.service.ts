import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

interface PendingJoinEntry {
  discordUserId: string;
  wispaceUserId: number;
  discordUsername: string;
  expiresAt: number;
  completed?: boolean;
  dmChannelId?: string;
}

const TTL_MS = 15 * 60 * 1000; // 15 minutes

/** Browser-bound HttpOnly cookie that carries the pending-link capability. */
export const PENDING_LINK_COOKIE_NAME = 'pending_link';

export const PENDING_LINK_TTL_MS = TTL_MS;

@Injectable()
export class DiscordPendingJoinService {
  private readonly store = new Map<string, PendingJoinEntry>();

  create(
    discordUserId: string,
    wispaceUserId: number,
    discordUsername: string,
  ): string {
    const token = randomUUID();
    this.store.set(token, {
      discordUserId,
      wispaceUserId,
      discordUsername,
      expiresAt: Date.now() + TTL_MS,
    });
    return token;
  }

  get(token: string): PendingJoinEntry | undefined {
    const entry = this.store.get(token);
    if (!entry) return undefined;
    if (!entry.completed && Date.now() > entry.expiresAt) {
      this.store.delete(token);
      return undefined;
    }
    return entry;
  }

  /** Find pending entry by Discord user ID (used by guildMemberAdd to auto-complete). */
  findByDiscordUserId(
    discordUserId: string,
  ): { token: string; entry: PendingJoinEntry } | undefined {
    for (const [token, entry] of this.store.entries()) {
      if (entry.discordUserId === discordUserId && !entry.completed) {
        if (Date.now() > entry.expiresAt) {
          this.store.delete(token);
          continue;
        }
        return { token, entry };
      }
    }
    return undefined;
  }

  /** Consume the capability exactly once — replay after completion/expiry is rejected. */
  consume(token: string): PendingJoinEntry | undefined {
    const entry = this.get(token);
    if (!entry) return undefined;
    this.store.delete(token);
    return entry;
  }

  /** Mark token as completed so the frontend poll can detect success. */
  markCompleted(token: string, dmChannelId?: string): void {
    const entry = this.store.get(token);
    if (entry) {
      entry.completed = true;
      if (dmChannelId) entry.dmChannelId = dmChannelId;
    }
  }

  delete(token: string): void {
    this.store.delete(token);
  }
}
