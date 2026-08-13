import { readResponseText } from '@wispace/bot-common';
import { WispaceApiError } from '../errors/wispace-api.error';
import { mergeWithTimeout } from '../utils/abort-signal.utils';
import {
  buildWispaceHeaders,
  type WispaceIdHeader,
} from '../utils/wispace-headers';
import type { PrecreateExerciseResult } from '../types/precreate-exercise.types';
import type { WispaceApiClientConfig } from './wispace-client-types';

export class PrecreateExerciseApiClient {
  constructor(private readonly config: WispaceApiClientConfig) {}

  async precreateNextExercise(
    idHeader: WispaceIdHeader,
    externalUserId: string,
    options?: { signal?: AbortSignal },
  ): Promise<PrecreateExerciseResult> {
    const response = await fetch(this.config.url, {
      method: 'POST',
      headers: buildWispaceHeaders(
        idHeader,
        externalUserId,
        this.config.internalKey,
      ),
      signal: mergeWithTimeout(
        options?.signal,
        this.config.requestTimeoutMs ?? 30_000,
      ),
    });

    if (!response.ok) {
      const body = await readResponseText(response);
      throw new WispaceApiError(
        `Precreate exercise API failed: HTTP ${response.status} ${response.statusText} - ${body}`,
        response.status,
        externalUserId,
        'PrecreateExercise',
      );
    }

    const text = await readResponseText(response);
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new Error('Precreate exercise API returned malformed JSON');
    }

    return this.normalize(payload);
  }

  private normalize(payload: unknown): PrecreateExerciseResult {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Precreate exercise API returned an invalid response');
    }

    const record = payload as Record<string, unknown>;
    if (
      typeof record.hasRoadmap !== 'boolean' ||
      typeof record.finishedAllExercises !== 'boolean' ||
      typeof record.alreadyExists !== 'boolean'
    ) {
      throw new Error('Precreate exercise API returned invalid status flags');
    }

    const message =
      typeof record.message === 'string' ? record.message.trim() : undefined;

    if (!record.hasRoadmap) return { status: 'no_roadmap', message };
    if (record.finishedAllExercises) return { status: 'finished_all', message };

    const status = record.alreadyExists ? 'already_exists' : 'created';
    const exerciseUrl = this.readHttpsUrl(record.exerciseUrl);
    return { status, exerciseUrl, message };
  }

  private readHttpsUrl(value: unknown): string {
    if (typeof value !== 'string') {
      throw new Error(
        'Precreate exercise API returned an invalid exercise URL',
      );
    }

    const url = value.trim();
    try {
      if (new URL(url).protocol !== 'https:') throw new Error();
    } catch {
      throw new Error(
        'Precreate exercise API returned an invalid exercise URL',
      );
    }

    return url;
  }
}
