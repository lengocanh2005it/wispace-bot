import { InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LlmJsonResponse, LlmProviderAdapter } from '@wispace/llm-agent';
import { StudentReportNoScoreDataError } from '../../domain/errors/student-report-no-score-data.error';
import {
  StudentReportRetryableError,
  WispaceApiError,
} from '../../domain/errors/wispace-api.error';
import {
  buildStudentReportApiUnavailableMessage,
  buildStudentReportNoScoreDataMessage,
} from '@wispace/student-report';
import { TaskScoreAverageApiService } from '../infrastructure/wispace/task-score-average-api.service';
import { StudentReportService } from './student-report.service';

const mockAdapter = {
  isConfigured: () => true,
  getDefaultModel: () => 'gpt-5.4',
} as unknown as LlmProviderAdapter;

describe('StudentReportService', () => {
  const capacityInput = {
    exam_date: '2026-07-01',
    exam_date_display: '01/07/2026',
    current_date: '27/06/2026',
    days_until_exam: 4,
    exam_has_passed: false,
    target_band: 7,
    task1_band: 6,
    task2_band: 6.5,
    total_essays_task1: 3,
    total_essays_task2: 5,
  };

  function makeJsonResponse(content: string): LlmJsonResponse {
    return {
      content,
      metadata: {
        provider: 'openai',
        model: 'gpt-5.4',
        responseId: 'resp-1',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    };
  }

  it('returns friendly message when Wispace has no score data (R1)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const studentCapacityService = {
      getCapacityData: jest.fn(() =>
        Promise.reject(new StudentReportNoScoreDataError('psid-1')),
      ),
    } as unknown as TaskScoreAverageApiService;

    const service = new StudentReportService(
      { get: () => undefined } as unknown as ConfigService,
      studentCapacityService,
      { recordFromCompletion: jest.fn() } as never,
      { run: jest.fn((fn: () => unknown) => fn()) } as never,
      mockAdapter,
    );

    await expect(service.generateReport('psid-1')).resolves.toBe(
      buildStudentReportNoScoreDataMessage(),
    );
  });

  it('rethrows non-score errors', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const studentCapacityService = {
      getCapacityData: jest.fn(() =>
        Promise.reject(new InternalServerErrorException('API down')),
      ),
    } as unknown as TaskScoreAverageApiService;

    const service = new StudentReportService(
      { get: () => undefined } as unknown as ConfigService,
      studentCapacityService,
      { recordFromCompletion: jest.fn() } as never,
      { run: jest.fn((fn: () => unknown) => fn()) } as never,
      mockAdapter,
    );

    await expect(service.generateReport('psid-1')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('throws StudentReportRetryableError on Wispace 5xx (R3)', async () => {
    jest.useFakeTimers();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const studentCapacityService = {
      getCapacityData: jest.fn(() =>
        Promise.reject(
          new WispaceApiError(
            'server error',
            503,
            'psid-1',
            'TaskScoreAverage',
          ),
        ),
      ),
    } as unknown as TaskScoreAverageApiService;

    const service = new StudentReportService(
      { get: () => undefined } as unknown as ConfigService,
      studentCapacityService,
      { recordFromCompletion: jest.fn() } as never,
      { run: jest.fn((fn: () => unknown) => fn()) } as never,
      mockAdapter,
    );

    const promise = service.generateReport('psid-1');
    const assertion = expect(promise).rejects.toBeInstanceOf(
      StudentReportRetryableError,
    );
    await jest.advanceTimersByTimeAsync(5_000);
    await jest.advanceTimersByTimeAsync(10_000);
    await assertion;
    jest.useRealTimers();
  });

  it('returns unavailable message on Wispace 4xx (R3)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const studentCapacityService = {
      getCapacityData: jest.fn(() =>
        Promise.reject(
          new WispaceApiError('not found', 404, 'psid-1', 'User/goals'),
        ),
      ),
    } as unknown as TaskScoreAverageApiService;

    const service = new StudentReportService(
      { get: () => undefined } as unknown as ConfigService,
      studentCapacityService,
      { recordFromCompletion: jest.fn() } as never,
      { run: jest.fn((fn: () => unknown) => fn()) } as never,
      mockAdapter,
    );

    await expect(service.generateReport('psid-1')).resolves.toBe(
      buildStudentReportApiUnavailableMessage(),
    );
  });

  it('falls back when LLM returns invalid report JSON shape', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const studentCapacityService = {
      getCapacityData: jest.fn(() => Promise.resolve(capacityInput)),
    } as unknown as TaskScoreAverageApiService;

    const service = new StudentReportService(
      {
        get: jest.fn((key: string) =>
          key === 'OPENAI_API_KEY' ? 'sk-test' : undefined,
        ),
      } as unknown as ConfigService,
      studentCapacityService,
      { recordFromCompletion: jest.fn() } as never,
      {
        run: jest.fn(() =>
          Promise.resolve(makeJsonResponse('{"headline":"ok"}')),
        ),
      } as never,
      mockAdapter,
    );

    await expect(service.generateReport('psid-1')).resolves.toContain(
      'Bạn còn 4 ngày nữa',
    );
  });

  it('caches the daily report and serves repeats without a second LLM call', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const studentCapacityService = {
      getCapacityData: jest.fn(() => Promise.resolve(capacityInput)),
    } as unknown as TaskScoreAverageApiService;

    const llmRun = jest.fn(() =>
      Promise.resolve(makeJsonResponse('{"headline":"ok"}')),
    );
    const service = new StudentReportService(
      {
        get: jest.fn((key: string) =>
          key === 'OPENAI_API_KEY' ? 'sk-test' : undefined,
        ),
      } as unknown as ConfigService,
      studentCapacityService,
      { recordFromCompletion: jest.fn() } as never,
      { run: llmRun } as never,
      mockAdapter,
    );

    const first = await service.generateReport('psid-1');
    const second = await service.generateReport('psid-1');

    expect(second).toBe(first);
    expect(llmRun).toHaveBeenCalledTimes(1);
    expect(service.getCachedReport('psid-1')).toBe(first);
  });

  it('generateReportStatic builds a deterministic report without any LLM call', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const studentCapacityService = {
      getCapacityData: jest.fn(() => Promise.resolve(capacityInput)),
    } as unknown as TaskScoreAverageApiService;

    const llmRun = jest.fn();
    const service = new StudentReportService(
      { get: () => undefined } as unknown as ConfigService,
      studentCapacityService,
      { recordFromCompletion: jest.fn() } as never,
      { run: llmRun } as never,
      mockAdapter,
    );

    const text = await service.generateReportStatic('psid-1');

    expect(text).toContain('Bạn còn 4 ngày nữa');
    expect(llmRun).not.toHaveBeenCalled();
  });
});
