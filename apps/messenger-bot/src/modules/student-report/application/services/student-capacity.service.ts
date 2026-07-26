import { Injectable } from '@nestjs/common';
import { TaskScoreAverageApiService } from '../../infrastructure/wispace/task-score-average-api.service';
import type { StudentCapacityInput } from '@wispace/student-report';

@Injectable()
export class StudentCapacityService {
  constructor(
    private readonly taskScoreAverageApiService: TaskScoreAverageApiService,
  ) {}

  getCapacityData(psid: string): Promise<StudentCapacityInput> {
    return this.taskScoreAverageApiService.getCapacityData(psid);
  }
}
