import { Injectable } from '@nestjs/common';
import type { CronHeartbeatInfo } from './types';

@Injectable()
export class CronHeartbeatRegistry {
  private readonly crons = new Map<
    string,
    {
      expectedIntervalMs: number;
      lastTickAt: Date | null;
      lastSuccessAt: Date | null;
      lastError: string | null;
    }
  >();

  registerCron(name: string, expectedIntervalMs: number): void {
    if (!this.crons.has(name)) {
      this.crons.set(name, {
        expectedIntervalMs,
        lastTickAt: null,
        lastSuccessAt: null,
        lastError: null,
      });
    }
  }

  recordTick(
    name: string,
    expectedIntervalMs = 60_000,
    success = true,
    error?: Error | string | null,
  ): void {
    const now = new Date();
    const existing = this.crons.get(name);
    const interval =
      expectedIntervalMs || existing?.expectedIntervalMs || 60_000;
    const errString =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : null;

    this.crons.set(name, {
      expectedIntervalMs: interval,
      lastTickAt: now,
      lastSuccessAt: success ? now : (existing?.lastSuccessAt ?? null),
      lastError: success ? null : errString,
    });
  }

  getRegisteredCrons(): Record<string, CronHeartbeatInfo> {
    const result: Record<string, CronHeartbeatInfo> = {};
    const now = Date.now();

    for (const [name, data] of this.crons.entries()) {
      let status: 'healthy' | 'stale' | 'never_run' = 'never_run';
      if (data.lastTickAt) {
        const elapsed = now - data.lastTickAt.getTime();
        // Stale if elapsed > 2.5x expected interval
        status = elapsed > data.expectedIntervalMs * 2.5 ? 'stale' : 'healthy';
      }

      result[name] = {
        name,
        expectedIntervalMs: data.expectedIntervalMs,
        lastTickAt: data.lastTickAt ? data.lastTickAt.toISOString() : null,
        lastSuccessAt: data.lastSuccessAt
          ? data.lastSuccessAt.toISOString()
          : null,
        lastError: data.lastError,
        status,
      };
    }
    return result;
  }

  hasStaleCrons(): boolean {
    const crons = this.getRegisteredCrons();
    return Object.values(crons).some((c) => c.status === 'stale');
  }

  reset(): void {
    this.crons.clear();
  }
}
