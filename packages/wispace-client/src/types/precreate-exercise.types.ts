import type { WispaceApiClientConfig } from '../clients/wispace-client-types';

export type PrecreateExerciseStatus =
  | 'created'
  | 'already_exists'
  | 'finished_all'
  | 'no_roadmap';

export interface PrecreateExerciseResult {
  status: PrecreateExerciseStatus;
  exerciseUrl?: string;
  message?: string;
}

export type PrecreateExerciseClientConfig = Omit<
  WispaceApiClientConfig,
  'maxRetries' | 'baseDelayMs'
> & {
  requestTimeoutMs: number;
};
