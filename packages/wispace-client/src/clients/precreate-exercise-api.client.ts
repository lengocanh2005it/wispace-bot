import { z } from 'zod';
import { readHttpsUrl } from '@wispace/bot-common/utils';
import { WispaceApiError } from '../errors/wispace-api.error';
import { mergeWithTimeout } from '../utils/abort-signal.utils';
import {
  buildWispaceHeaders,
  type WispaceIdHeader,
} from '../utils/wispace-headers';
import { fetchWispaceJson } from '../utils/fetch-wispace-json';
import { keepAliveFetch } from '../utils/keep-alive-agent';
import { validateShape } from '../utils/validate-shape';
import type {
  PrecreateExerciseResult,
  PrecreateExerciseClientConfig,
} from '../types/precreate-exercise.types';

const precreateResponseSchema = z.object({
  hasRoadmap: z.boolean(),
  finishedAllExercises: z.boolean(),
  alreadyExists: z.boolean(),
  exerciseUrl: z.string().nullish(),
  message: z.string().nullish(),
});

export class PrecreateExerciseApiClient {
  constructor(private readonly config: PrecreateExerciseClientConfig) {}

  async precreateNextExercise(
    idHeader: WispaceIdHeader,
    externalUserId: string,
    options?: { signal?: AbortSignal },
  ): Promise<PrecreateExerciseResult> {
    const call = async (): Promise<PrecreateExerciseResult> => {
      const response = await keepAliveFetch(
        this.config.url,
        {
          method: 'POST',
          headers: buildWispaceHeaders(
            idHeader,
            externalUserId,
            this.config.internalKey,
          ),
          signal: mergeWithTimeout(
            options?.signal,
            this.config.requestTimeoutMs,
          ),
        },
        { poolSize: this.config.poolSize },
      );

      if (!response.ok) {
        throw new WispaceApiError(
          `Precreate exercise API failed: HTTP ${response.status} ${response.statusText}`,
          response.status,
          externalUserId,
          'PrecreateExercise',
        );
      }

      return this.normalize(await fetchWispaceJson(response));
    };
    return (
      this.config.metrics?.timeWispaceCall(
        'PrecreateExercise',
        'create',
        call,
      ) ?? call()
    );
  }

  private normalize(payload: unknown): PrecreateExerciseResult {
    const record = validateShape(precreateResponseSchema, payload);

    const message =
      record.message !== null && record.message !== undefined
        ? record.message.trim()
        : undefined;

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
