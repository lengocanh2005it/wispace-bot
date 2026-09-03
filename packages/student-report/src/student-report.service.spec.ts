import { StudentReportCore } from './student-report.service';
import {
  StudentReportNoScoreDataError,
  isStudentReportRetryableError,
  type RetryableApiError,
} from './errors';
import type { StudentCapacityInput } from './types';
import type { LlmProviderAdapter, LlmJsonResponse } from '@wispace/llm-agent';

const baseInput: StudentCapacityInput = {
  exam_date: '2026-08-01',
  exam_date_display: '01/08/2026',
  current_date: '2026-07-01',
  days_until_exam: 31,
  exam_has_passed: false,
  target_band: 7,
  task1_band: 6,
  task2_band: 6.5,
  total_essays_task1: 5,
  total_essays_task2: 4,
};

function makeRetryableError(statusCode: number): RetryableApiError {
  const error = new Error('upstream failed') as RetryableApiError;
  error.statusCode = statusCode;
  error.endpoint = '/task-score-average';
  error.isRetryable = () => statusCode >= 500 && statusCode <= 599;
  return error;
}

describe('StudentReportCore', () => {
  it('returns the no-score-data guidance message without calling the LLM', async () => {
    const llmExecution = { run: jest.fn() };
    const usageRecorder = { recordFromCompletion: jest.fn() };
    const capacityData = {
      getCapacityData: jest
        .fn()
        .mockRejectedValue(new StudentReportNoScoreDataError('user-1')),
    };
    const adapter = {
      isConfigured: () => false,
      getDefaultModel: () => 'gpt-5.4',
    } as unknown as LlmProviderAdapter;

    const core = new StudentReportCore(
      { adapter, systemPrompt: 'prompt' },
      { llmExecution, usageRecorder, capacityData },
    );

    const result = await core.generateReport('user-1');

    expect(result).toContain('chưa thấy bài Writing nào được chấm');
    expect(llmExecution.run).not.toHaveBeenCalled();
  });

  it('returns a fallback report when adapter is not configured', async () => {
    const llmExecution = { run: jest.fn() };
    const usageRecorder = { recordFromCompletion: jest.fn() };
    const capacityData = {
      getCapacityData: jest.fn().mockResolvedValue(baseInput),
    };
    const degradedMode = jest.fn();
    const adapter = {
      isConfigured: () => false,
      getDefaultModel: () => 'gpt-5.4',
    } as unknown as LlmProviderAdapter;

    const core = new StudentReportCore(
      { adapter, systemPrompt: 'prompt' },
      {
        llmExecution,
        usageRecorder,
        capacityData,
        platform: 'discord',
        degradedMode,
      },
    );

    const result = await core.generateReport('user-1');

    expect(result).toContain('còn 31 ngày');
    expect(llmExecution.run).not.toHaveBeenCalled();
    expect(degradedMode).toHaveBeenCalledWith({
      platform: 'discord',
      feature: 'STUDENT_REPORT',
      failureClass: 'provider_unconfigured',
      action: 'report_fallback',
      correlationId: 'user-1',
    });
  });

  it('throws StudentReportRetryableError after exhausting 5xx fetch retries', async () => {
    jest.useFakeTimers();
    const llmExecution = { run: jest.fn() };
    const usageRecorder = { recordFromCompletion: jest.fn() };
    const capacityData = {
      getCapacityData: jest.fn().mockRejectedValue(makeRetryableError(503)),
    };
    const adapter = {
      isConfigured: () => false,
      getDefaultModel: () => 'gpt-5.4',
    } as unknown as LlmProviderAdapter;

    const core = new StudentReportCore(
      { adapter, systemPrompt: 'prompt' },
      { llmExecution, usageRecorder, capacityData },
    );

    const promise = core.generateReport('user-1');
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'StudentReportRetryableError',
      externalUserId: 'user-1',
    });
    await jest.advanceTimersByTimeAsync(5_000);
    await jest.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(capacityData.getCapacityData).toHaveBeenCalledTimes(3);
    jest.useRealTimers();
  });

  it('succeeds on a retry after a transient 5xx fetch error', async () => {
    jest.useFakeTimers();
    const llmExecution = { run: jest.fn() };
    const usageRecorder = { recordFromCompletion: jest.fn() };
    const capacityData = {
      getCapacityData: jest
        .fn()
        .mockRejectedValueOnce(makeRetryableError(503))
        .mockResolvedValueOnce(baseInput),
    };
    const adapter = {
      isConfigured: () => false,
      getDefaultModel: () => 'gpt-5.4',
    } as unknown as LlmProviderAdapter;

    const core = new StudentReportCore(
      { adapter, systemPrompt: 'prompt' },
      { llmExecution, usageRecorder, capacityData },
    );

    const promise = core.generateReport('user-1');
    await jest.advanceTimersByTimeAsync(5_000);
    const result = await promise;

    expect(capacityData.getCapacityData).toHaveBeenCalledTimes(2);
    expect(result).toContain('còn 31 ngày');
    jest.useRealTimers();
  });

  it('returns the api-unavailable message on a 4xx capacity fetch error', async () => {
    const llmExecution = { run: jest.fn() };
    const usageRecorder = { recordFromCompletion: jest.fn() };
    const capacityData = {
      getCapacityData: jest.fn().mockRejectedValue(makeRetryableError(404)),
    };
    const adapter = {
      isConfigured: () => false,
      getDefaultModel: () => 'gpt-5.4',
    } as unknown as LlmProviderAdapter;

    const core = new StudentReportCore(
      { adapter, systemPrompt: 'prompt' },
      { llmExecution, usageRecorder, capacityData },
    );

    const result = await core.generateReport('user-1');
    expect(result).toContain('chưa lấy được đủ dữ liệu học tập');
    expect(capacityData.getCapacityData).toHaveBeenCalledTimes(1);
  });

  it('calls the LLM and records usage when adapter is configured', async () => {
    const response: LlmJsonResponse = {
      content: JSON.stringify({ headline: 'Headline' }),
      metadata: {
        provider: 'openrouter',
        model: 'openrouter/quality-model',
        responseId: 'resp-1',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
    };

    const llmExecution = {
      run: jest.fn().mockResolvedValue(response),
    };
    const usageRecorder = { recordFromCompletion: jest.fn() };
    const capacityData = {
      getCapacityData: jest.fn().mockResolvedValue(baseInput),
    };
    const adapter = {
      isConfigured: () => true,
      getDefaultModel: () => 'gpt-5.4',
      generateJson: jest.fn().mockResolvedValue(response),
    } as unknown as LlmProviderAdapter;

    const core = new StudentReportCore(
      { adapter, systemPrompt: 'prompt' },
      { llmExecution, usageRecorder, capacityData },
    );

    const result = await core.generateReport('user-1');

    // Factual fields are deterministic from source; the LLM only supplies prose.
    expect(result).toContain('còn 31 ngày');
    expect(result).toContain('Headline');
    expect(result).toContain('Bạn đã làm 5 bài Task 1 và 4 bài Task 2.');
    expect(usageRecorder.recordFromCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'STUDENT_REPORT',
        externalUserId: 'user-1',
        provider: 'openrouter',
        model: 'openrouter/quality-model',
      }),
    );
  });

  it('passes cached tokens through to usage recording (#553)', async () => {
    const response: LlmJsonResponse = {
      content: JSON.stringify({ headline: 'Headline' }),
      metadata: {
        provider: 'openai',
        model: 'gpt-5.4',
        responseId: 'resp-1',
        usage: {
          promptTokens: 100,
          completionTokens: 5,
          totalTokens: 105,
          cachedTokens: 60,
        },
      },
    };

    const llmExecution = {
      run: jest.fn().mockResolvedValue(response),
    };
    const usageRecorder = { recordFromCompletion: jest.fn() };
    const capacityData = {
      getCapacityData: jest.fn().mockResolvedValue(baseInput),
    };
    const adapter = {
      isConfigured: () => true,
      getDefaultModel: () => 'gpt-5.4',
      generateJson: jest.fn().mockResolvedValue(response),
    } as unknown as LlmProviderAdapter;

    const core = new StudentReportCore(
      { adapter, systemPrompt: 'prompt' },
      { llmExecution, usageRecorder, capacityData },
    );

    await core.generateReport('user-1');

    expect(usageRecorder.recordFromCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        response: expect.objectContaining({
          usage: expect.objectContaining({ cachedTokens: 60 }),
        }),
      }),
    );
  });

  it('keeps the delivered report factually consistent when the LLM output contradicts the source', async () => {
    const response: LlmJsonResponse = {
      content: JSON.stringify({
        headline: 'Cố gắng lên nhé!',
        streak: 'Bạn đã làm 999 bài Task 1.',
        'tình trạng task 2': 'Task 2 đang ở band 9.0.',
        'tình trạng task 1': 'Task 1 đang ở band 9.0.',
      }),
      metadata: {
        provider: 'openai',
        model: 'gpt-5.4',
        responseId: 'resp-1',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
    };

    const llmExecution = {
      run: jest.fn().mockResolvedValue(response),
    };
    const usageRecorder = { recordFromCompletion: jest.fn() };
    const capacityData = {
      getCapacityData: jest.fn().mockResolvedValue(baseInput),
    };
    const adapter = {
      isConfigured: () => true,
      getDefaultModel: () => 'gpt-5.4',
      generateJson: jest.fn().mockResolvedValue(response),
    } as unknown as LlmProviderAdapter;

    const core = new StudentReportCore(
      { adapter, systemPrompt: 'prompt' },
      { llmExecution, usageRecorder, capacityData },
    );

    const result = await core.generateReport('user-1');

    // Factual headline + streak/status come from source, never from the model.
    expect(result).toContain('còn 31 ngày');
    expect(result).toContain('Cố gắng lên nhé!');
    expect(result).not.toContain('999 bài');
    expect(result).not.toContain('band 9.0');
    expect(result).toContain('Bạn đã làm 5 bài Task 1 và 4 bài Task 2.');
    expect(result).toContain('Task 1 đang ở band 6, thấp hơn mục tiêu');
  });

  it('falls back to a deterministic report when the LLM output is invalid', async () => {
    const response: LlmJsonResponse = {
      content: '{}',
      metadata: {
        provider: 'openai',
        model: 'gpt-5.4',
        responseId: 'resp-1',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
    };

    const llmExecution = {
      run: jest.fn().mockResolvedValue(response),
    };
    const usageRecorder = { recordFromCompletion: jest.fn() };
    const capacityData = {
      getCapacityData: jest.fn().mockResolvedValue(baseInput),
    };
    const adapter = {
      isConfigured: () => true,
      getDefaultModel: () => 'gpt-5.4',
      generateJson: jest.fn().mockResolvedValue(response),
    } as unknown as LlmProviderAdapter;

    const core = new StudentReportCore(
      { adapter, systemPrompt: 'prompt' },
      { llmExecution, usageRecorder, capacityData },
    );

    const result = await core.generateReport('user-1');
    expect(result).toContain('còn 31 ngày');
  });

  it('aborts generateReportStatic when the signal is already aborted (agent timed out)', async () => {
    const capacityData = {
      getCapacityData: jest.fn().mockResolvedValue(baseInput),
    };
    const core = new StudentReportCore(
      { adapter: {} as LlmProviderAdapter, systemPrompt: 'prompt' },
      {
        llmExecution: { run: jest.fn() },
        usageRecorder: { recordFromCompletion: jest.fn() },
        capacityData,
      },
    );
    const aborted = new AbortController();
    aborted.abort();

    await expect(
      core.generateReportStatic('user-1', aborted.signal),
    ).rejects.toThrow('aborted');
    // No capacity fetch after the caller gave up.
    expect(capacityData.getCapacityData).not.toHaveBeenCalled();
  });

  it('classifies an aborted report generation as retryable', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('deadline exceeded', 'TimeoutError'));
    const core = new StudentReportCore(
      { adapter: {} as LlmProviderAdapter, systemPrompt: 'prompt' },
      {
        llmExecution: { run: jest.fn() },
        usageRecorder: { recordFromCompletion: jest.fn() },
        capacityData: { getCapacityData: jest.fn() },
      },
    );

    const error = await core
      .generateReportStatic('user-1', controller.signal)
      .catch((value: unknown) => value);

    expect(isStudentReportRetryableError(error)).toBe(true);
  });
});
