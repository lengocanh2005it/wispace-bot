import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { createHash } from 'crypto';
import { errorMessage } from '@wispace/bot-common/masking';
import type { Platform, PlatformLinkState } from '@wispace/contracts';
import type {
  PlatformLinkAuditEventType,
  PlatformLinkObservation,
} from '../types';

const TABLES: Record<Platform, { table: string; idType: 'number' | 'string' }> =
  {
    messenger: { table: 'user_platform_mappings', idType: 'number' },
    discord: { table: 'discord_account_links', idType: 'string' },
    zalo: { table: 'zalo_account_links', idType: 'string' },
  };

export interface PlatformLinkRow {
  id: string;
  platform: Platform;
  externalUserId: string;
  userId?: number;
  state: PlatformLinkState;
  generation: string;
  ownershipVersion?: string;
  lastVerifiedAt?: Date;
  revokedAt?: Date;
}

export interface PlatformLinkTransition {
  outcome:
    | 'active'
    | 'recovered'
    | 'revoked'
    | 'unknown'
    | 'stale_writer'
    | 'locally_unlinked';
  generation?: string;
  userId?: number;
  /** False when the observation confirms an already-terminal state. */
  changed?: boolean;
}

export interface PlatformLinkStatusReader {
  readonly enabled: boolean;
  getStatus(externalUserId: string): Promise<PlatformLinkObservation>;
}

/**
 * Transactional ownership state for all three platform mapping tables.
 * Identifiers are selected from a fixed allowlist; no caller-controlled SQL
 * identifiers are accepted.
 */
@Injectable()
export class PlatformLinkStateService {
  private readonly logger = new Logger(PlatformLinkStateService.name);

  constructor(private readonly dataSource: DataSource) {}

  async getLink(
    platform: Platform,
    externalUserId: string,
  ): Promise<PlatformLinkRow | null> {
    const table = TABLES[platform].table;
    const rows = await this.dataSource.query<RawLinkRow[]>(
      `SELECT id::text AS id, platform, external_user_id AS "externalUserId",
              user_id AS "userId", COALESCE(link_state, 'active') AS state,
              COALESCE(mapping_generation, 1)::text AS generation,
              upstream_ownership_version AS "ownershipVersion",
              last_verified_at AS "lastVerifiedAt", revoked_at AS "revokedAt"
       FROM "${table}"
       WHERE platform = $1 AND external_user_id = $2
       ORDER BY id DESC LIMIT 1`,
      [platform, externalUserId],
    );
    if (rows[0]) return this.toRow(rows[0], platform);

    // Privacy unlink removes the mapping row. Keep a hash-only tombstone in
    // the bounded audit table so an in-flight verify intent cannot recreate it.
    const tombstones = await this.dataSource.query<RawTombstoneRow[]>(
      `SELECT mapping_generation AS "mappingGeneration", created_at AS "createdAt"
       FROM platform_link_audit_events
       WHERE platform = $1 AND external_user_hash = $2
         AND event_type = 'locally_unlinked'
       ORDER BY created_at DESC LIMIT 1`,
      [platform, hashExternalId(externalUserId)],
    );
    const tombstone = tombstones[0];
    return tombstone
      ? {
          id: `tombstone:${hashExternalId(externalUserId)}`,
          platform,
          externalUserId,
          state: 'locally-unlinked',
          generation: String(tombstone.mappingGeneration ?? '1'),
          revokedAt: tombstone.createdAt,
        }
      : null;
  }

  async listLinks(
    platform: Platform,
    afterId: string | undefined,
    limit: number,
  ): Promise<PlatformLinkRow[]> {
    const table = TABLES[platform].table;
    const rows = await this.dataSource.query<RawLinkRow[]>(
      `SELECT id::text AS id, platform, external_user_id AS "externalUserId",
              user_id AS "userId", COALESCE(link_state, 'active') AS state,
              COALESCE(mapping_generation, 1)::text AS generation,
              upstream_ownership_version AS "ownershipVersion",
              last_verified_at AS "lastVerifiedAt", revoked_at AS "revokedAt"
       FROM "${table}"
       WHERE platform = $1 AND external_user_id IS NOT NULL AND id > $2
       ORDER BY id ASC LIMIT $3`,
      [platform, afterId ?? '0', Math.max(1, Math.min(limit, 500))],
    );
    return rows.map((row) => this.toRow(row, platform));
  }

  async applyObservation(
    platform: Platform,
    externalUserId: string,
    observation: PlatformLinkObservation,
    options: { expectedGeneration?: string } = {},
  ): Promise<PlatformLinkTransition> {
    const table = TABLES[platform].table;
    return this.dataSource.transaction(async (manager) => {
      const rows = await manager.query<RawLinkRow[]>(
        `SELECT id::text AS id, platform, external_user_id AS "externalUserId",
                user_id AS "userId", COALESCE(link_state, 'active') AS state,
                COALESCE(mapping_generation, 1)::text AS generation,
                upstream_ownership_version AS "ownershipVersion",
                last_verified_at AS "lastVerifiedAt", revoked_at AS "revokedAt"
         FROM "${table}"
         WHERE platform = $1 AND external_user_id = $2
         ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [platform, externalUserId],
      );
      if (!rows[0]) return { outcome: 'locally_unlinked' };

      const current = this.toRow(rows[0], platform);
      if (
        options.expectedGeneration !== undefined &&
        current.generation !== options.expectedGeneration
      ) {
        await this.writeAudit(manager, {
          platform,
          externalUserId,
          mappingGeneration: current.generation,
          eventType: 'stale_writer',
          reason: 'mapping_generation_changed_during_status_check',
          ownershipVersion:
            observation.kind === 'active' || observation.kind === 'revoked'
              ? observation.ownershipVersion
              : undefined,
        });
        return {
          outcome: 'stale_writer',
          generation: current.generation,
          userId: current.userId,
        };
      }
      // A local privacy unlink is an explicit ownership fence. Status polling
      // must not turn the tombstone back into an active link; only a fresh
      // relink upsert may do that.
      if (current.state === 'locally-unlinked') {
        return {
          outcome: 'locally_unlinked',
          generation: current.generation,
          userId: current.userId,
          changed: false,
        };
      }
      if (observation.kind === 'active') {
        if (observation.userId !== current.userId) {
          return this.revoke(
            manager,
            table,
            platform,
            externalUserId,
            current,
            'upstream_user_mismatch',
            observation.ownershipVersion,
          );
        }
        if (current.state === 'confirmed-revoked') {
          await this.writeAudit(manager, {
            platform,
            externalUserId,
            mappingGeneration: current.generation,
            eventType: 'stale_writer',
            reason: 'active_observation_cannot_resurrect_revoked_mapping',
            ownershipVersion: observation.ownershipVersion,
          });
          return {
            outcome: 'stale_writer',
            generation: current.generation,
            userId: current.userId,
          };
        }
        await manager.query(
          `UPDATE "${table}"
           SET link_state = 'active', last_verified_at = now(),
               last_unknown_at = NULL, revoked_at = NULL,
               revocation_reason = NULL,
               upstream_ownership_version = $3, updated_at = now()
           WHERE id = $1 AND platform = $2`,
          [current.id, platform, observation.ownershipVersion ?? null],
        );
        if (current.state === 'temporarily-unknown') {
          await this.writeAudit(manager, {
            platform,
            externalUserId,
            mappingGeneration: current.generation,
            eventType: 'recovered',
            ownershipVersion: observation.ownershipVersion,
          });
          return {
            outcome: 'recovered',
            generation: current.generation,
            userId: current.userId,
          };
        }
        return {
          outcome: 'active',
          generation: current.generation,
          userId: current.userId,
        };
      }

      if (observation.kind === 'unknown') {
        if (current.state === 'confirmed-revoked') {
          return {
            outcome: 'revoked',
            generation: current.generation,
            userId: current.userId,
            changed: false,
          };
        }
        await manager.query(
          `UPDATE "${table}"
           SET link_state = 'temporarily-unknown', last_unknown_at = now(),
               updated_at = now()
           WHERE id = $1 AND platform = $2`,
          [current.id, platform],
        );
        if (current.state !== 'temporarily-unknown') {
          await this.writeAudit(manager, {
            platform,
            externalUserId,
            mappingGeneration: current.generation,
            eventType: 'unknown',
            reason: observation.reason,
          });
        }
        return {
          outcome: 'unknown',
          generation: current.generation,
          userId: current.userId,
          changed: current.state !== 'temporarily-unknown',
        };
      }

      if (current.state === 'confirmed-revoked') {
        return {
          outcome: 'revoked',
          generation: current.generation,
          userId: current.userId,
          changed: false,
        };
      }
      return this.revoke(
        manager,
        table,
        platform,
        externalUserId,
        current,
        observation.reason,
        observation.ownershipVersion,
      );
    });
  }

  async reconcile(
    platform: Platform,
    reader: PlatformLinkStatusReader,
    options: {
      pageSize?: number;
      concurrency?: number;
      onRevoked?: (externalUserId: string, userId?: number) => Promise<void>;
      onUnknown?: (externalUserId: string, userId?: number) => Promise<void>;
    } = {},
  ): Promise<{
    checked: number;
    revoked: number;
    unknown: number;
    recovered: number;
    staleWriter: number;
  }> {
    if (!reader.enabled) {
      return {
        checked: 0,
        revoked: 0,
        unknown: 0,
        recovered: 0,
        staleWriter: 0,
      };
    }
    let afterId: string | undefined;
    const totals = {
      checked: 0,
      revoked: 0,
      unknown: 0,
      recovered: 0,
      staleWriter: 0,
    };
    const pageSize = options.pageSize ?? 100;
    const concurrency = Math.max(1, Math.min(options.concurrency ?? 5, 20));
    for (;;) {
      const rows = await this.listLinks(platform, afterId, pageSize);
      if (rows.length === 0) break;
      await mapWithConcurrency(rows, concurrency, async (row) => {
        const result = await reader.getStatus(row.externalUserId);
        const transition = await this.applyObservation(
          platform,
          row.externalUserId,
          result,
          { expectedGeneration: row.generation },
        );
        totals.checked += 1;
        const changed = transition.changed !== false;
        if (transition.outcome === 'revoked' && changed) totals.revoked += 1;
        if (transition.outcome === 'unknown') totals.unknown += 1;
        if (transition.outcome === 'recovered') totals.recovered += 1;
        if (transition.outcome === 'stale_writer') totals.staleWriter += 1;
        if (transition.outcome === 'revoked' && changed) {
          await options.onRevoked?.(row.externalUserId, transition.userId);
        }
        if (transition.outcome === 'unknown') {
          await options.onUnknown?.(row.externalUserId, transition.userId);
        }
      });
      afterId = rows[rows.length - 1].id;
    }
    this.logger.log(
      `platform link reconciliation platform=${platform} checked=${totals.checked} revoked=${totals.revoked} unknown=${totals.unknown} recovered=${totals.recovered}`,
    );
    return totals;
  }

  private async revoke(
    manager: EntityManager,
    table: string,
    platform: Platform,
    externalUserId: string,
    current: PlatformLinkRow,
    reason: string,
    ownershipVersion?: string,
  ): Promise<PlatformLinkTransition> {
    const generation = String(BigInt(current.generation || '1') + 1n);
    await manager.query(
      `UPDATE "${table}"
       SET link_state = 'confirmed-revoked', mapping_generation = $3,
           revoked_at = now(), revocation_reason = $4,
           upstream_ownership_version = $5, updated_at = now()
       WHERE id = $1 AND platform = $2`,
      [
        current.id,
        platform,
        generation,
        errorMessage(reason, {
          maxChars: 160,
          externalUserId,
        }),
        ownershipVersion ?? null,
      ],
    );
    await this.suspendPendingWork(
      manager,
      platform,
      externalUserId,
      'link_revoked',
    );
    await manager.query(
      `DELETE FROM learner_profiles WHERE platform = $1 AND external_user_id = $2`,
      [platform, externalUserId],
    );
    await this.writeAudit(manager, {
      platform,
      externalUserId,
      mappingGeneration: generation,
      eventType: 'revoked',
      reason,
      ownershipVersion,
    });
    return { outcome: 'revoked', generation, userId: current.userId };
  }

  private async suspendPendingWork(
    manager: EntityManager,
    platform: Platform,
    externalUserId: string,
    reason: 'link_status_unknown' | 'link_revoked',
  ): Promise<void> {
    await manager.query(
      `UPDATE study_reminder_jobs
       SET status = 'cancelled', lease_token = NULL, lease_expires_at = NULL,
           last_error = $3, updated_at = now()
       WHERE platform = $1 AND external_user_id = $2
         AND status IN ('pending','processing','failed')`,
      [platform, externalUserId, reason],
    );
    await manager.query(
      `UPDATE report_send_jobs
       SET status = 'cancelled', lease_token = NULL, lease_expires_at = NULL,
           last_error = $3, updated_at = now()
       WHERE platform = $1 AND external_user_id = $2
         AND status IN ('pending','processing','failed')`,
      [platform, externalUserId, reason],
    );
    await manager.query(
      `UPDATE scheduled_report_claims
       SET status = 'cancelled', lease_token = NULL, lease_expires_at = NULL,
           updated_at = now()
       WHERE platform = $1 AND external_user_id = $2 AND status = 'claimed'`,
      [platform, externalUserId],
    );
  }

  private async writeAudit(
    manager: EntityManager,
    input: {
      platform: Platform;
      externalUserId: string;
      mappingGeneration?: string;
      eventType: PlatformLinkAuditEventType;
      reason?: string;
      ownershipVersion?: string;
    },
  ): Promise<void> {
    await manager.query(
      `INSERT INTO platform_link_audit_events
        (platform, external_user_hash, mapping_generation, event_type, reason, ownership_version)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.platform,
        hashExternalId(input.externalUserId),
        input.mappingGeneration ?? null,
        input.eventType,
        input.reason
          ? errorMessage(input.reason, {
              maxChars: 160,
              externalUserId: input.externalUserId,
            })
          : null,
        input.ownershipVersion
          ? errorMessage(input.ownershipVersion, { maxChars: 160 })
          : null,
      ],
    );
  }

  private toRow(row: RawLinkRow, platform: Platform): PlatformLinkRow {
    return {
      id: String(row.id),
      platform,
      externalUserId: row.externalUserId,
      userId: Number(row.userId),
      state: row.state ?? 'active',
      generation: String(row.generation ?? '1'),
      ownershipVersion: row.ownershipVersion ?? undefined,
      lastVerifiedAt: row.lastVerifiedAt ?? undefined,
      revokedAt: row.revokedAt ?? undefined,
    };
  }
}

function hashExternalId(externalUserId: string): string {
  return createHash('sha256').update(externalUserId).digest('hex');
}

interface RawLinkRow {
  id: string;
  platform: Platform;
  externalUserId: string;
  userId: number | null;
  state: PlatformLinkState;
  generation: string;
  ownershipVersion: string | null;
  lastVerifiedAt: Date | null;
  revokedAt: Date | null;
}

interface RawTombstoneRow {
  mappingGeneration: string | null;
  createdAt: Date;
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const run = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      await worker(values[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => run()),
  );
}
