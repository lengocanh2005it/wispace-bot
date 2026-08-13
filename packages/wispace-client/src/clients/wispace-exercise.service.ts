import { Injectable } from '@nestjs/common';
import { WispaceConfigService } from '../config/wispace-config.service';
import type { PrecreateExerciseResult } from '../types/precreate-exercise.types';
import type { WispaceIdHeader } from '../utils/wispace-headers';
import { PrecreateExerciseApiClient } from './precreate-exercise-api.client';

@Injectable()
export class WispaceExerciseService {
  private client?: PrecreateExerciseApiClient;

  constructor(
    private readonly idHeader: WispaceIdHeader,
    private readonly configService: WispaceConfigService,
  ) {}

  precreateNextExercise(
    externalUserId: string,
    options?: { signal?: AbortSignal },
  ): Promise<PrecreateExerciseResult> {
    return this.getClient().precreateNextExercise(
      this.idHeader,
      externalUserId,
      options,
    );
  }

  private getClient(): PrecreateExerciseApiClient {
    if (!this.client) {
      this.client = new PrecreateExerciseApiClient(
        this.configService.buildPrecreateExerciseClientConfig(),
      );
    }

    return this.client;
  }
}
