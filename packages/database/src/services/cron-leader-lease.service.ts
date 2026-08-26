import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { errorMessage } from '@wispace/bot-common/masking';
import { CronLeaderLeaseEntity } from '../entities/cron-leader-lease.entity';

const DEFAULT_LEASE_TTL_MS = 3 * 60 * 1000;

/**
 * Lease-based leader election for scheduled crons. `claim` atomically takes
 * the lease if it is free (no row), owned by this instance, or expired —
 * so a dead leader is automatically replaced by the next claiming pod.
 */
@Injectable()
export class CronLeaderLeaseService {
  private readonly logger = new Logger(CronLeaderLeaseService.name);

  constructor(
    @InjectRepository(CronLeaderLeaseEntity)
    private readonly repo: Repository<CronLeaderLeaseEntity>,
  ) {}

  async claim(name: string, instanceId: string): Promise<boolean> {
    try {
      const rows: Array<{ instance_id: string }> = await this.repo.query(
        `
        INSERT INTO cron_leader_leases (name, instance_id, expires_at)
        VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval)
        ON CONFLICT (name) DO UPDATE SET
          instance_id = EXCLUDED.instance_id,
          expires_at = EXCLUDED.expires_at,
          updated_at = now()
        WHERE cron_leader_leases.instance_id = EXCLUDED.instance_id
           OR cron_leader_leases.expires_at < now()
        RETURNING instance_id
      `,
        [name, instanceId, DEFAULT_LEASE_TTL_MS],
      );

      return rows.length > 0 && rows[0].instance_id === instanceId;
    } catch (error) {
      // A DB blip must not block the cron — fail open (advisory lock still
      // serializes the batch between pods).
      this.logger.warn(
        `Leader lease claim failed name=${name}: ${errorMessage(error)} — running anyway`,
      );
      return true;
    }
  }

  async heartbeat(name: string, instanceId: string): Promise<void> {
    try {
      await this.repo.query(
        `
        INSERT INTO cron_leader_leases (name, instance_id, expires_at)
        VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval)
        ON CONFLICT (name) DO UPDATE SET
          expires_at = EXCLUDED.expires_at,
          updated_at = now()
        WHERE cron_leader_leases.instance_id = EXCLUDED.instance_id
      `,
        [name, instanceId, DEFAULT_LEASE_TTL_MS],
      );
    } catch (error) {
      this.logger.warn(
        `Leader lease heartbeat failed name=${name}: ${errorMessage(error)}`,
      );
    }
  }
}
