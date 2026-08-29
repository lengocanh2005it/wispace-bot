import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import { WispaceApiError } from '../errors/wispace-api.error';
import { isAbortError } from '@wispace/bot-common/utils';
import { fetchWispaceJson } from '../utils/fetch-wispace-json';
import { buildWispaceHeaders } from '../utils/wispace-headers';
import { isWispaceRetryable, withRetry } from '../utils/with-retry';
import type {
  WispaceLinkStatusClientConfig,
  WispaceLinkStatusResult,
} from '../types/link-status.types';

export interface WispaceLinkStatusLogger {
  warn(message: string): void;
}

const NOOP_LOGGER: WispaceLinkStatusLogger = { warn: () => undefined };

/**
 * Reads the canonical WISPACE ownership state for one platform identity.
 * A missing/invalid response is deliberately `unknown`, never `revoked`.
 */
export class WispaceLinkStatusClient {
  private readonly config: WispaceLinkStatusClientConfig;
  private readonly logger: WispaceLinkStatusLogger;

  constructor(
    config: WispaceLinkStatusClientConfig,
    logger: WispaceLinkStatusLogger = NOOP_LOGGER,
  ) {
    this.config = config;
    this.logger = logger;
  }

  get enabled(): boolean {
    return (
      this.config.enabled === true &&
      !!this.config.url &&
      !!this.config.internalKey
    );
  }

  async getStatus(
    externalUserId: string,
    options?: { signal?: AbortSignal },
  ): Promise<WispaceLinkStatusResult> {
    if (!this.enabled)
      return { kind: 'unknown', reason: 'status_check_disabled' };

    try {
      return await withRetry(
        () => this.fetchStatus(externalUserId, options?.signal),
        {
          maxRetries: this.config.maxRetries ?? 2,
          baseDelayMs: this.config.baseDelayMs ?? 500,
          shouldRetry: isWispaceRetryable,
          signal: options?.signal,
          onRetry: (attempt, max, error) =>
            this.logger.warn(
              `WISPACE link-status retry ${attempt}/${max} externalUserId=${maskExternalId(
                externalUserId,
              )}: ${errorMessage(error)}`,
            ),
        },
      );
    } catch (error) {
      if (isAbortError(error)) throw error;
      this.logger.warn(
        `WISPACE link-status unavailable externalUserId=${maskExternalId(
          externalUserId,
        )}: ${errorMessage(error)}`,
      );
      return { kind: 'unknown', reason: 'upstream_unavailable' };
    }
  }

  private async fetchStatus(
    externalUserId: string,
    signal?: AbortSignal,
  ): Promise<WispaceLinkStatusResult> {
    const timeoutSignal = AbortSignal.timeout(
      this.config.requestTimeoutMs ?? 5_000,
    );
    let response: Response;
    try {
      response = await fetch(this.config.url!, {
        headers: buildWispaceHeaders(
          this.config.header,
          externalUserId,
          this.config.internalKey!,
        ),
        signal: signal
          ? AbortSignal.any([signal, timeoutSignal])
          : timeoutSignal,
      });
    } catch (error) {
      // A request-local timeout is transient and must pass through the retry
      // policy. Only a caller-owned abort cancels reconciliation outright.
      if (timeoutSignal.aborted && !signal?.aborted) {
        throw new TypeError('WISPACE link-status request timed out');
      }
      throw error;
    }

    if (response.status === 404 || response.status === 410) {
      return { kind: 'revoked', reason: `http_${response.status}` };
    }
    if (!response.ok) {
      throw new WispaceApiError(
        `WISPACE link-status failed: HTTP ${response.status}`,
        response.status,
        externalUserId,
        'link-status',
      );
    }

    let body: unknown;
    try {
      body = await fetchWispaceJson(response);
    } catch {
      return { kind: 'unknown', reason: 'invalid_response' };
    }

    return this.parseResult(body);
  }

  private parseResult(body: unknown): WispaceLinkStatusResult {
    if (!body || typeof body !== 'object') {
      return { kind: 'unknown', reason: 'invalid_response' };
    }

    const value = body as Record<string, unknown>;
    const status =
      typeof value.status === 'string' ? value.status.toLowerCase() : '';
    const revoked =
      value.revoked === true ||
      value.active === false ||
      value.linked === false ||
      value.valid === false ||
      status === 'revoked' ||
      status === 'unlinked';
    if (revoked) {
      return {
        kind: 'revoked',
        reason:
          typeof value.reason === 'string' && value.reason.trim()
            ? value.reason.trim().slice(0, 120)
            : 'upstream_revoked',
        ownershipVersion: this.readVersion(value),
      };
    }

    const active =
      value.active === true || value.linked === true || status === 'active';
    const userId = Number(value.userId);
    if (active && Number.isSafeInteger(userId) && userId > 0) {
      return {
        kind: 'active',
        userId,
        ownershipVersion: this.readVersion(value),
      };
    }

    return { kind: 'unknown', reason: 'invalid_response' };
  }

  private readVersion(value: Record<string, unknown>): string | undefined {
    const version = value.ownershipVersion ?? value.version ?? value.etag;
    return typeof version === 'string' && version.trim()
      ? version.trim().slice(0, 160)
      : undefined;
  }
}
