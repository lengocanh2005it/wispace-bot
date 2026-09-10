import * as adapters from './adapters';
import * as core from './core';

describe('scheduler-core package boundaries', () => {
  it('keeps scheduling contracts and utilities in core', () => {
    expect(core.ReportScheduleService).toBeUndefined();
    expect(core.ReportSendJobStatus).toBeUndefined();
    expect(core.todayReportDate).toBeDefined();
    expect(core.runBatched).toBeDefined();
    expect(core.REPORT_SEND_JOB_REPOSITORY).toBeDefined();

    expect(adapters.ReportScheduleService).toBeDefined();
    expect(adapters.ReportCronLeaderService).toBeDefined();
    expect(adapters.ReportOrchestrationService).toBeDefined();
  });
});
