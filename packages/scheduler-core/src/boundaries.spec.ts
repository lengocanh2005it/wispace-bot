import * as adapters from './adapters';
import * as core from './core';

const coreExports = core as Record<string, unknown>;

describe('scheduler-core package boundaries', () => {
  it('keeps scheduling contracts and utilities in core', () => {
    expect(coreExports.ReportScheduleService).toBeUndefined();
    expect(coreExports.ReportSendJobStatus).toBeUndefined();
    expect(core.todayReportDate).toBeDefined();
    expect(core.runBatched).toBeDefined();
    expect(core.REPORT_SEND_JOB_REPOSITORY).toBeDefined();

    expect(adapters.ReportScheduleService).toBeDefined();
    expect(adapters.ReportCronLeaderService).toBeDefined();
    expect(adapters.ReportOrchestrationService).toBeDefined();
  });
});
