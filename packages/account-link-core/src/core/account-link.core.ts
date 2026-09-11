import type { PlatformLinkState } from '@wispace/contracts';

export interface LinkIdentity {
  externalUserId: string;
  displayName?: string;
}

export interface LinkVerificationResult {
  valid: boolean;
  userId?: number;
}

export interface LinkUpsertResult {
  relinked: boolean;
  previousUserId?: number;
}

export interface LinkStateSnapshot {
  state: PlatformLinkState;
  generation?: string;
  revokedAt?: Date;
}

export type LinkMappingObservation =
  | { kind: 'absent' }
  | { kind: 'present'; generation: string };

export interface VerifyIntentIdentity {
  externalUserId: string;
  userId: number;
  intentGeneration: string;
}

export interface VerifyIntentRecord extends VerifyIntentIdentity {
  verifiedAt: Date;
  mappingObservation: LinkMappingObservation;
}

/** Durable handoff between upstream token verification and local mapping. */
export interface VerifyIntentStore {
  recordVerify(
    externalUserId: string,
    userId: number,
    mappingObservation: LinkMappingObservation,
  ): Promise<{ intentGeneration: string }>;
  consumeRecord(intent: VerifyIntentIdentity): Promise<boolean | void>;
}

/** Reconcile-specific read/cleanup seam for durable verify intents. */
export interface VerifyIntentReconcileStore {
  listStaleRecords(olderThanMs: number): Promise<VerifyIntentRecord[]>;
  consumeRecord(intent: VerifyIntentIdentity): Promise<boolean | void>;
}

export interface LinkExchangePort<P> {
  exchange(input: P): Promise<LinkIdentity>;
}

export interface LinkTokenVerifierPort {
  verifyToken(
    linkToken: string,
    externalUserId: string,
  ): Promise<LinkVerificationResult>;
}

export interface LinkMappingObservationPort {
  getMappingObservation(
    externalUserId: string,
  ): Promise<LinkMappingObservation>;
}

export interface LinkMappingPort {
  upsertLink(
    userId: number,
    externalUserId: string,
    mappingObservation: LinkMappingObservation,
  ): Promise<LinkUpsertResult | void>;
  findUserId?(externalUserId: string): Promise<number | undefined>;
}

export interface LinkStatePort {
  getLinkState?(externalUserId: string): Promise<LinkStateSnapshot | undefined>;
  isFreshRelink?(externalUserId: string, userId: number): Promise<boolean>;
}

export interface LinkClarificationPort {
  clearClarification?(externalUserId: string): Promise<void>;
}

export interface LinkCompletionHooks {
  afterCommit?(
    context: LinkCompletionAfterCommitContext,
  ): Promise<LinkCompletionAfterCommitResult | void>;
}

export interface LinkCompletionInput<P> {
  input: P;
  linkToken: string;
}

export interface LinkCompletionAfterCommitContext {
  identity: LinkIdentity;
  userId: number;
  linkResult: LinkUpsertResult;
}

export interface LinkCompletionAfterCommitResult {
  nextAction?: 'join-community';
}

export interface LinkFlowAdapter<P>
  extends
    LinkExchangePort<P>,
    LinkTokenVerifierPort,
    VerifyIntentStore,
    LinkMappingObservationPort,
    LinkMappingPort,
    LinkClarificationPort,
    LinkCompletionHooks {}

export type LinkCompletionPorts<P> = LinkFlowAdapter<P>;
export type AccountLinkCorePorts<P> = LinkFlowAdapter<P>;

export interface LinkRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  rng?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  shouldRetry?: (error: unknown) => boolean;
}

export interface LinkCompletionOptions {
  retry?: LinkRetryOptions;
  onBestEffortError?: (
    step: 'consume' | 'clarification' | 'after-commit',
    error: unknown,
  ) => void;
}

export interface LinkCompletionResult {
  status: 'linked';
  nextAction?: 'join-community';
}

export type LinkOutcome = LinkCompletionResult;

export class LinkTokenRejectedError extends Error {
  constructor() {
    super('WISPACE link token rejected');
    this.name = 'LinkTokenRejectedError';
  }
}

export class LinkPersistenceExhaustedError extends Error {
  constructor(cause: unknown) {
    super('Account link persistence exhausted after token verification', {
      cause,
    });
    this.name = 'LinkPersistenceExhaustedError';
  }
}

export class LinkConflictError extends Error {
  constructor(cause: unknown) {
    super('Account link ownership changed during completion', { cause });
    this.name = 'LinkConflictError';
  }
}

const DEFAULT_COMPLETION_RETRY: Required<
  Pick<LinkRetryOptions, 'maxAttempts' | 'baseDelayMs'>
> = {
  maxAttempts: 3,
  baseDelayMs: 500,
};

export class LinkCompletionCore<P> {
  constructor(
    private readonly ports: LinkCompletionPorts<P>,
    private readonly options: LinkCompletionOptions = {},
  ) {}

  async complete(input: LinkCompletionInput<P>): Promise<LinkCompletionResult> {
    const identity = await this.ports.exchange(input.input);
    const mappingObservation = await this.ports.getMappingObservation(
      identity.externalUserId,
    );
    const verification = await this.ports.verifyToken(
      input.linkToken,
      identity.externalUserId,
    );
    if (!verification.valid || verification.userId === undefined) {
      throw new LinkTokenRejectedError();
    }
    const userId = verification.userId;

    let intentGeneration: string;
    try {
      ({ intentGeneration } = await retry(
        () =>
          this.ports.recordVerify(
            identity.externalUserId,
            userId,
            mappingObservation,
          ),
        this.options.retry,
      ));
    } catch (error) {
      throw new LinkPersistenceExhaustedError(error);
    }
    const intent = {
      externalUserId: identity.externalUserId,
      userId,
      intentGeneration,
    };
    let linkResult: LinkUpsertResult;
    try {
      linkResult = (await retry(
        () =>
          this.ports.upsertLink(
            userId,
            identity.externalUserId,
            mappingObservation,
          ),
        this.options.retry,
      )) ?? { relinked: false };
    } catch (error) {
      if (!isOwnershipConflict(error)) {
        throw new LinkPersistenceExhaustedError(error);
      }
      await this.bestEffort('consume', () => this.ports.consumeRecord(intent));
      throw new LinkConflictError(error);
    }

    await this.bestEffort('consume', () => this.ports.consumeRecord(intent));
    await this.bestEffort('clarification', () =>
      this.ports.clearClarification?.(identity.externalUserId),
    );

    let nextAction: LinkCompletionResult['nextAction'];
    try {
      const result = await this.ports.afterCommit?.({
        identity,
        userId,
        linkResult,
      });
      nextAction = result?.nextAction;
    } catch (error) {
      this.options.onBestEffortError?.('after-commit', error);
    }

    return { status: 'linked', ...(nextAction ? { nextAction } : {}) };
  }

  private async bestEffort(
    step: 'consume' | 'clarification',
    operation: () => Promise<unknown> | undefined,
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.options.onBestEffortError?.(step, error);
    }
  }
}

export interface LinkReconcilePorts
  extends
    VerifyIntentReconcileStore,
    LinkMappingPort,
    LinkStatePort,
    LinkClarificationPort {
  findUserId(externalUserId: string): Promise<number | undefined>;
  reconcileLinkStatus?(): Promise<void>;
}

export interface LinkReconcileContext {
  record: VerifyIntentRecord;
  linkResult: LinkUpsertResult;
}

export interface LinkReconcileOptions {
  now?: () => Date;
  maxRecords?: number;
  retry?: LinkRetryOptions;
  onOutcome?: (
    outcome: LinkReconcileOutcome,
    record: VerifyIntentRecord,
    error?: unknown,
  ) => void;
  onMismatch?: (record: VerifyIntentRecord, existingUserId: number) => void;
  onDropped?: (record: VerifyIntentRecord, reason: string) => void;
  onReconciled?: (context: LinkReconcileContext) => Promise<void>;
  onBestEffortError?: (
    step: 'clarification' | 'side-effect',
    error: unknown,
  ) => void;
}

export type LinkReconcileOutcome =
  | 'reconciled'
  | 'already_committed'
  | 'dropped'
  | 'mismatched'
  | 'failed';

export interface LinkReconcileBatchResult {
  records: number;
  reconciled: number;
  alreadyCommitted: number;
  dropped: number;
  mismatched: number;
  failed: number;
}

const DEFAULT_RECONCILE_RETRY: Required<
  Pick<LinkRetryOptions, 'maxAttempts' | 'baseDelayMs'>
> = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
};

export class LinkReconcileCronCore {
  constructor(private readonly ports: LinkReconcilePorts) {}

  async run(
    options: Parameters<LinkReconcileCronCore['runBatch']>[0],
  ): Promise<LinkReconcileBatchResult> {
    await this.ports.reconcileLinkStatus?.();
    return this.runBatch(options);
  }

  async runBatch(options: {
    staleAgeMs: number;
    maxRecordAgeMs: number;
    now?: () => Date;
    maxRecords?: number;
    retry?: LinkRetryOptions;
    onOutcome?: LinkReconcileOptions['onOutcome'];
    onMismatch?: LinkReconcileOptions['onMismatch'];
    onDropped?: LinkReconcileOptions['onDropped'];
    onReconciled?: LinkReconcileOptions['onReconciled'];
    onBestEffortError?: LinkReconcileOptions['onBestEffortError'];
  }): Promise<LinkReconcileBatchResult> {
    const now = options.now ?? (() => new Date());
    const records = (
      await this.ports.listStaleRecords(options.staleAgeMs)
    ).slice(0, options.maxRecords ?? 100);
    const result: LinkReconcileBatchResult = {
      records: records.length,
      reconciled: 0,
      alreadyCommitted: 0,
      dropped: 0,
      mismatched: 0,
      failed: 0,
    };

    for (const record of records) {
      try {
        const existingUserId = await this.ports.findUserId(
          record.externalUserId,
        );
        if (existingUserId === record.userId) {
          await this.clearClarification(record.externalUserId, options);
          await this.ports.consumeRecord(record);
          result.alreadyCommitted += 1;
          options.onOutcome?.('already_committed', record);
          continue;
        }

        const stale =
          now().getTime() - record.verifiedAt.getTime() >=
          options.maxRecordAgeMs;
        if (stale) {
          await this.dropRecord(
            record,
            `older than ${options.maxRecordAgeMs}ms with no mapping (user must retry with a fresh token)`,
            options,
          );
          result.dropped += 1;
          continue;
        }

        const state = await this.ports.getLinkState?.(record.externalUserId);
        if (await this.isBlocked(record, state)) {
          await this.dropRecord(
            record,
            `mapping state ${state?.state} blocks stale verify intent`,
            options,
          );
          result.dropped += 1;
          continue;
        }

        let linkResult: LinkUpsertResult;
        try {
          linkResult = (await retry(
            () =>
              this.ports.upsertLink(
                record.userId,
                record.externalUserId,
                record.mappingObservation,
              ),
            { ...DEFAULT_RECONCILE_RETRY, ...options.retry },
          )) ?? { relinked: false };
        } catch (error) {
          if (!isOwnershipConflict(error)) throw error;
          if (existingUserId !== undefined) {
            options.onMismatch?.(record, existingUserId);
          }
          await this.ports.consumeRecord(record);
          result.mismatched += 1;
          options.onOutcome?.('mismatched', record);
          continue;
        }
        await this.clearClarification(record.externalUserId, options);
        await this.ports.consumeRecord(record);
        result.reconciled += 1;
        options.onOutcome?.('reconciled', record);
        try {
          await options.onReconciled?.({ record, linkResult });
        } catch (error) {
          options.onBestEffortError?.('side-effect', error);
        }
      } catch (error) {
        result.failed += 1;
        options.onOutcome?.('failed', record, error);
      }
    }

    return result;
  }

  private async isBlocked(
    record: VerifyIntentRecord,
    state: LinkStateSnapshot | undefined,
  ): Promise<boolean> {
    if (!state) return false;
    if (state.state === 'confirmed-revoked') return true;
    if (state.state === 'active') return false;
    if (
      state.state === 'locally-unlinked' &&
      state.revokedAt &&
      record.verifiedAt <= state.revokedAt
    ) {
      return true;
    }
    return !(await this.ports.isFreshRelink?.(
      record.externalUserId,
      record.userId,
    ));
  }

  private async dropRecord(
    record: VerifyIntentRecord,
    reason: string,
    options: {
      onDropped?: LinkReconcileOptions['onDropped'];
      onOutcome?: LinkReconcileOptions['onOutcome'];
    },
  ): Promise<void> {
    options.onDropped?.(record, reason);
    await this.ports.consumeRecord(record);
    options.onOutcome?.('dropped', record);
  }

  private async clearClarification(
    externalUserId: string,
    options: { onBestEffortError?: LinkReconcileOptions['onBestEffortError'] },
  ): Promise<void> {
    try {
      await this.ports.clearClarification?.(externalUserId);
    } catch (error) {
      options.onBestEffortError?.('clarification', error);
    }
  }
}

export function readPositiveInteger(
  raw: string | undefined,
  fallback: number,
): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

async function retry<T>(
  operation: () => Promise<T>,
  options: LinkRetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(
    1,
    Math.floor(options.maxAttempts ?? DEFAULT_COMPLETION_RETRY.maxAttempts),
  );
  const baseDelayMs = Math.max(
    0,
    options.baseDelayMs ?? DEFAULT_COMPLETION_RETRY.baseDelayMs,
  );
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry;
  const sleep = options.sleep ?? defaultSleep;
  const rng = options.rng ?? Math.random;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !shouldRetry(error)) throw error;
      await sleep(jitteredDelayMs(baseDelayMs * attempt, rng));
    }
  }

  throw lastError;
}

function defaultShouldRetry(error: unknown): boolean {
  return (
    !(error instanceof Error && error.name === 'AbortError') &&
    !isOwnershipConflict(error)
  );
}

function isOwnershipConflict(error: unknown): boolean {
  return error instanceof Error && error.name.includes('OwnershipConflict');
}

function jitteredDelayMs(nominalMs: number, rng: () => number): number {
  const random = Math.min(1, Math.max(0, rng()));
  return Math.floor(nominalMs / 2 + random * (nominalMs / 2));
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
