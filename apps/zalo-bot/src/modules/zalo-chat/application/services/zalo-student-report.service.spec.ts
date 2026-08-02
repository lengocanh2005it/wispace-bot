import { ConfigService } from '@nestjs/config';
import { ZaloStudentReportService } from './zalo-student-report.service';
import type { ZaloLlmUsageRecorderService } from '../../infrastructure/persistence/zalo-llm-usage-recorder.service';
import type { ZaloWispaceGoalsService } from '@zalo/modules/wispace/application/services/zalo-wispace-goals.service';
import type { LlmProviderAdapter } from '@wispace/llm-agent';

jest.mock('@wispace/llm-agent', () => ({
  loadSystemPromptFile: jest.fn().mockReturnValue('system prompt'),
}));

const mockGenerateReport = jest
  .fn<Promise<string>, unknown[]>()
  .mockResolvedValue('mock report');

jest.mock('@wispace/student-report', () => ({
  StudentReportCore: jest.fn().mockImplementation(() => ({
    generateReport: mockGenerateReport,
  })),
}));

describe('ZaloStudentReportService', () => {
  const buildService = (overrides?: { maxConcurrent?: string }) => {
    const configGet = jest.fn((key: string) => {
      if (key === 'LLM_MAX_CONCURRENT') return overrides?.maxConcurrent ?? '3';
      if (key === 'STUDY_REMINDER_TIMEZONE') return 'Asia/Ho_Chi_Minh';
      return undefined;
    });
    const config = { get: configGet } as unknown as ConfigService;
    const goalsService = {} as unknown as ZaloWispaceGoalsService;
    const usageRecorder = {
      recordFromCompletion: jest.fn(),
    } as unknown as ZaloLlmUsageRecorderService;
    const adapter = {} as unknown as LlmProviderAdapter;

    return new ZaloStudentReportService(
      config,
      goalsService,
      usageRecorder,
      adapter,
    );
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates StudentReportCore lazily on first generateReport call', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { StudentReportCore } = jest.requireMock('@wispace/student-report');
    const service = buildService();

    await service.generateReport('zalo-1');

    expect(StudentReportCore).toHaveBeenCalledTimes(1);
  });

  it('reuses StudentReportCore on subsequent calls', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { StudentReportCore } = jest.requireMock('@wispace/student-report');
    const service = buildService();

    await service.generateReport('zalo-1');
    await service.generateReport('zalo-1');

    expect(StudentReportCore).toHaveBeenCalledTimes(1);
  });

  it('generates report with correlationId containing userId and date', async () => {
    const service = buildService();

    await service.generateReport('zalo-1');

    expect(mockGenerateReport).toHaveBeenCalledWith('zalo-1', {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      correlationId: expect.stringContaining('zalo-1:'),
    });
  });

  it('returns the report text from the core', async () => {
    const service = buildService();

    const result: string = await service.generateReport('zalo-1');

    expect(result).toBe('mock report');
  });
});
