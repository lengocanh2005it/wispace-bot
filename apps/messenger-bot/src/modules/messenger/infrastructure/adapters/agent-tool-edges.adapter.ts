import { Injectable } from '@nestjs/common';
import {
  MemoizedWispaceGoalsService,
  PrecreateExerciseApiClient,
} from '@wispace/wispace-client/core';
import type {
  AgentExerciseCreatePort,
  AgentGoalsReadPort,
} from '../../application/agent/agent-tool-edges.port';

@Injectable()
export class AgentGoalsReadAdapter implements AgentGoalsReadPort {
  constructor(private readonly goals: MemoizedWispaceGoalsService) {}

  getUserGoals(externalId: string) {
    return this.goals.getUserGoals(externalId);
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
