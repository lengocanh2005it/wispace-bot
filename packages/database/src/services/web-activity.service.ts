import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

const DEFAULT_DORMANT_DAYS = 7;
const DORMANT_REASON = 'recipient dormant (web inactivity)';
const TZ_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/;

/** Cancellation reason written to study_reminder_jobs + used as the metric branch key. */
export { DORMANT_REASON };

/**
 * Append 'Z' when an ISO-8601 string carries no timezone designator, so a bare
 * `2026-08-29T10:00:00` is read as UTC rather than the server's local zone.
 * Absent or unparseable input falls back to `now`.
 */
export function normalizeToUtcIso(
  raw: string | undefined,
  now: Date = new Date(),
): string {
  if (!raw) return now.toISOString();
  const trimmed = raw.trim();
  const iso = TZ_SUFFIX.test(trimmed) ? trimmed : `${trimmed}Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? now.toISOString()
    : parsed.toISOString();
}

/**
 * Shared read/write for WISPACE web-activity dormancy. Mirrors
 * CanonicalPlatformService: a plain @Injectable in @wispace/database using the
 * shared DataSource. Fail-open: disabled gate or any DB error => not dormant.
 */
@Injectable()
export class WebActivityService {
  private readonly logger = new Logger(WebActivityService.name);
  private readonly enabled: boolean;
  private readonly dormantDays: number;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    this.enabled = config.get<string>('WEB_ACTIVITY_GATE_ENABLED') === 'true';
    const rawDays = config.get<string>('WEB_ACTIVITY_DORMANT_DAYS');
    const parsed = Number(rawDays);
    if (rawDays !== undefined && (!Number.isFinite(parsed) || parsed <= 0)) {
      this.logger.warn(
        `WEB_ACTIVITY_DORMANT_DAYS invalid (${rawDays}), using ${DEFAULT_DORMANT_DAYS}`,
      );
    }
    this.dormantDays =
      Number.isFinite(parsed) && parsed > 0
        ? Math.floor(parsed)
        : DEFAULT_DORMANT_DAYS;
  }

  get gateEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Upsert one row per userId. Single statement => atomic, no race. GREATEST
   * merge makes duplicate/out-of-order deliveries harmless; LEAST(...,now())
   * clamps a future timestamp. Always writes, even when the gate is disabled.
   */
  async recordActive(userId: number, activeAt?: string): Promise<void> {
    const normalized = normalizeToUtcIso(activeAt);
    await this.dataSource.query(
      `INSERT INTO web_activity (user_id, last_active_at, updated_at)
       VALUES ($1, LEAST($2::timestamptz, now()), now())
       ON CONFLICT (user_id) DO UPDATE
       SET last_active_at = GREATEST(web_activity.last_active_at, LEAST($2::timestamptz, now())),
           updated_at = now()`,
      [userId, normalized],
    );
  }

  /**
   * Subset of `userIds` whose last web activity is older than the threshold.
   * A userId with no row is absent from the result (never dormant).
   * Disabled gate / empty input / DB error => [] (keep sending).
   */
  async filterDormant(userIds: number[]): Promise<number[]> {
    if (!this.enabled || userIds.length === 0) return [];
    try {
      const rows: Array<{ user_id: number }> = await this.dataSource.query(
        `SELECT user_id FROM web_activity
         WHERE user_id = ANY($1::int[])
           AND last_active_at < now() - ($2 || ' days')::interval`,
        [userIds, this.dormantDays],
      );
      return rows.map((r) => Number(r.user_id));
    } catch (err) {
      this.logger.warn(
        `filterDormant failed, treating all as active: ${(err as Error).message}`,
      );
      return [];
    }
  }
}
