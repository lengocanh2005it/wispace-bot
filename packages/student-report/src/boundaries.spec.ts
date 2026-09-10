import * as adapters from './adapters';
import * as core from './core';

describe('student-report package boundaries', () => {
  it('keeps report policy in core and platform wiring in adapters', () => {
    expect(core.StudentReportCore).toBeDefined();
    expect(core.buildFallbackReport).toBeDefined();
    expect(core.PlatformStudentReportService).toBeUndefined();
    expect(adapters.PlatformStudentReportService).toBeDefined();
  });
});
