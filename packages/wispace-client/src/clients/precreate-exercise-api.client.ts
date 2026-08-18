import { readResponseText, sanitizeLogValue } from '@wispace/bot-common';
import { WispaceApiError } from '../errors/wispace-api.error';
import { mergeWithTimeout } from '../utils/abort-signal.utils';
import {
  buildWispaceHeaders,
  type WispaceIdHeader,
} from '../utils/wispace-headers';
import { readHttpsUrl } from '../utils/https-url';
import type { PrecreateExerciseResult } from '../types/precreate-exercise.types';
import type { PrecreateExerciseClientConfig } from '../types/precreate-exercise.types';

export class PrecreateExerciseApiClient {
  constructor(private readonly config: PrecreateExerciseClientConfig) {}

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
      signal: mergeWithTimeout(options?.signal, this.config.requestTimeoutMs),
    });

    if (!response.ok) {
      const body = await readResponseText(response);
      throw new WispaceApiError(
        `Precreate exercise API failed: HTTP ${response.status} ${response.statusText} - ${sanitizeLogValue(body, 200)}`,
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
    const exerciseUrl = readHttpsUrl(
      record.exerciseUrl,
      'Precreate exercise API returned an invalid exercise URL',
    );
    return { status, exerciseUrl, message };
  }
}
