import { ConfigService } from '@nestjs/config';
import { PlatformStudentReportService } from './platform-student-report.service';
import { createEnvLlmExecutionPort } from '@wispace/llm-agent';
import type { PlatformLlmUsageRecorderAdapter } from '@wispace/chat-metering';
import type { WispaceGoalsService } from '@wispace/wispace-client';
import type { LlmProviderAdapter } from '@wispace/llm-agent';

jest.mock('@wispace/llm-agent', () => ({
  ...jest.requireActual('@wispace/llm-agent'),
  loadSystemPromptFile: jest.fn().mockReturnValue('system prompt'),
  createEnvLlmExecutionPort: jest.fn(),
}));

const mockGenerateReport = jest
  .fn<Promise<string>, unknown[]>()
  .mockResolvedValue('mock report');

jest.mock('./student-report.service', () => ({
  StudentReportCore: jest.fn().mockImplementation(() => ({
    generateReport: mockGenerateReport,
  })),
}));

describe('PlatformStudentReportService', () => {
  const buildService = (overrides?: { maxConcurrent?: string }) => {
    const configGet = jest.fn((key: string) => {
      if (key === 'LLM_MAX_CONCURRENT') return overrides?.maxConcurrent ?? '3';
      if (key === 'STUDY_REMINDER_TIMEZONE') return 'Asia/Ho_Chi_Minh';
      return undefined;
    });
    const config = { get: configGet } as unknown as ConfigService;
    const goalsService = {} as unknown as WispaceGoalsService;
    const usageRecorder = {
      recordFromCompletion: jest.fn(),
    } as unknown as PlatformLlmUsageRecorderAdapter;
    const adapter = {} as unknown as LlmProviderAdapter;

    return new PlatformStudentReportService(
      'discord',
      config,
      goalsService,
      usageRecorder,
      adapter,
      '/prompts',
    );
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates StudentReportCore lazily on first generateReport call', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { StudentReportCore } = jest.requireMock('./student-report.service');
    const service = buildService();

    await service.generateReport('external-1');

    expect(StudentReportCore).toHaveBeenCalledTimes(1);
  });

  it('reuses StudentReportCore on subsequent calls', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { StudentReportCore } = jest.requireMock('./student-report.service');
    const service = buildService();

    await service.generateReport('external-1');
    await service.generateReport('external-1');

    expect(StudentReportCore).toHaveBeenCalledTimes(1);
  });

  it('generates report with correlationId containing userId and date', async () => {
    const service = buildService();

    await service.generateReport('external-1');

    expect(mockGenerateReport).toHaveBeenCalledWith('external-1', {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      correlationId: expect.stringContaining('external-1:'),
    });
  });

  it('returns the report text from the core', async () => {
    const service = buildService();

    const result: string = await service.generateReport('external-1');

    expect(result).toBe('mock report');
  });

  // Multi-platform regression (#389): Discord and Zalo reports both build
  // their execution port through this platform-parameterized service — the
  // bounded-admission contract must be passed through intact.
  it('wires the shared bounded-admission config into its execution port', async () => {
    const service = buildService();

    await service.generateReport('external-1');

    expect(createEnvLlmExecutionPort).toHaveBeenCalledWith(
      expect.objectContaining({
        maxConcurrent: 3,
        maxQueueDepth: 50,
        chatAdmissionWaitMs: 8000,
        backgroundAdmissionWaitMs: 1500,
      }),
      expect.anything(),
      expect.anything(),
      undefined,
    );
  });
});
