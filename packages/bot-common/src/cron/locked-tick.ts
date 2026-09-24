export type LockedTickOutcome = 'succeeded' | 'failed' | 'skipped';

export interface LockedTickItem<Detail = unknown> {
  outcome: LockedTickOutcome;
  details?: Detail;
}

export interface LockedTickSummary<Detail = unknown> {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  details: Detail[];
}

export interface LockedTickMetricsPort {
  recordCronSuccess(name: string): void;
}

export interface CronHeartbeatMetricsPort extends LockedTickMetricsPort {
  registerCron(name: string, expectedIntervalMs: number): void;
}

export interface LockedTickLoggerPort {
  debug(message: string): void;
}

export interface LockedTickOptions<Detail = unknown, Item = unknown> {
  name: string;
  enabled?: boolean;
  withLock: <Result>(run: () => Promise<Result>) => Promise<Result | null>;
  /** Existing services may provide their own bounded loop. */
  run?: () => Promise<readonly LockedTickItem<Detail>[]>;
  /** Or let the wrapper own the fetch/iterate/error-counting skeleton. */
  fetchBatch?: () => Promise<readonly Item[]>;
  processItem?: (item: Item) => Promise<LockedTickItem<Detail>>;
  metrics?: LockedTickMetricsPort;
  logger?: LockedTickLoggerPort;
}

/**
 * Runs one bounded batch behind a caller-owned lock and owns the common
 * orchestration summary. Domain services still own claims, leases, retries,
 * and item-level persistence transitions.
 */
export async function runLockedTick<Detail = unknown, Item = unknown>(
  options: LockedTickOptions<Detail, Item>,
): Promise<LockedTickSummary<Detail> | null> {
  if (options.enabled === false) return null;

  if (!options.run && (!options.fetchBatch || !options.processItem)) {
    throw new Error(
      `Locked tick ${options.name} requires run or fetchBatch/processItem`,
    );
  }

  const summary = await options.withLock(async () => {
    const items = options.run
      ? await options.run()
      : await runBatch(options.fetchBatch!, options.processItem!);
    return summarizeLockedTick(items);
  });

  if (summary == null) {
    options.logger?.debug(`${options.name} skipped — lock held by another pod`);
    return null;
  }

  options.metrics?.recordCronSuccess(options.name);
  return summary;
}

export function summarizeLockedTick<Detail>(
  items: readonly LockedTickItem<Detail>[],
): LockedTickSummary<Detail> {
  const summary: LockedTickSummary<Detail> = {
    processed: items.length,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    details: [],
  };

  for (const item of items) {
    summary[item.outcome] += 1;
    if (item.details !== undefined) summary.details.push(item.details);
  }

  return summary;
}

async function runBatch<Detail, Item>(
  fetchBatch: () => Promise<readonly Item[]>,
  processItem: (item: Item) => Promise<LockedTickItem<Detail>>,
): Promise<LockedTickItem<Detail>[]> {
  const items = await fetchBatch();
  const results: LockedTickItem<Detail>[] = [];

  for (const item of items) {
    try {
      results.push(await processItem(item));
    } catch {
      // Domain services own error logging and persistence transitions. A
      // failed item must not prevent the rest of the bounded batch running.
      results.push({ outcome: 'failed' });
    }
  }

  return results;
}
