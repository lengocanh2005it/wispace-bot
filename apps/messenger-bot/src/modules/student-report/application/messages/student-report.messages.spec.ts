import { buildStudentReportNoScoreDataMessage } from '@wispace/student-report';

describe('student-report.messages', () => {
  it('buildStudentReportNoScoreDataMessage returns Vietnamese guidance (R1)', () => {
    const message = buildStudentReportNoScoreDataMessage();

    expect(message).toContain('WISPACE');
    expect(message).toContain('Task 1');
    expect(message).toContain('Task 2');
  });
});
