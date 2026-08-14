import type {
  PrecreateExerciseClientConfig,
  PrecreateExerciseResult,
} from '../types/precreate-exercise.types';
import type { WispaceIdHeader } from '../utils/wispace-headers';
import { PrecreateExerciseApiClient } from './precreate-exercise-api.client';

export class WispaceExerciseService {
  private readonly client: PrecreateExerciseApiClient;

  constructor(
    private readonly idHeader: WispaceIdHeader,
    config: PrecreateExerciseClientConfig,
  ) {
    this.client = new PrecreateExerciseApiClient(config);
  }

  precreateNextExercise(
    externalUserId: string,
    options?: { signal?: AbortSignal },
  ): Promise<PrecreateExerciseResult> {
    return this.client.precreateNextExercise(
      this.idHeader,
      externalUserId,
      options,
    );
  }
}
