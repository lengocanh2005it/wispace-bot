import { Injectable } from '@nestjs/common';
import {
  PrecreateExerciseApiClient,
  WispaceDataCache,
} from '@wispace/wispace-client/core';
import { WispaceGoalsService } from '@wispace/wispace-client/adapters';
import type {
  AgentExerciseCreatePort,
  AgentGoalsReadPort,
} from '../../application/agent/agent-tool-edges.port';

@Injectable()
export class AgentGoalsReadAdapter implements AgentGoalsReadPort {
  constructor(
    private readonly goals: WispaceGoalsService,
    private readonly cache: WispaceDataCache,
  ) {}

  getUserGoals(externalId: string) {
    return this.cache.getOrFetch('goals', externalId, undefined, () =>
      this.goals.getUserGoals(externalId),
    );
  }
}

@Injectable()
export class AgentExerciseCreateAdapter implements AgentExerciseCreatePort {
  constructor(private readonly client: PrecreateExerciseApiClient) {}

  precreateNextExercise(
    idHeader: 'x-psid',
    externalId: string,
    options?: { signal?: AbortSignal },
  ) {
    return this.client.precreateNextExercise(idHeader, externalId, options);
  }
}
