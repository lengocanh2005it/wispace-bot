// Framework-free report policy, facts, ports, formatting, and errors.

export {
  StudentReportCore,
  type StudentReportConfig,
  type StudentReportPorts,
} from '../student-report.service';
export type { CapacityDataPort } from '../ports';
export type { StudentCapacityInput, StudentCapacityReport } from '../types';
export type { StudentReportProse } from '../report-formatter';
export {
  StudentReportNoScoreDataError,
  StudentReportRetryableError,
  isStudentReportRetryableError,
  type RetryableApiError,
} from '../errors';
export {
  buildStudentReportApiRetryMessage,
  buildStudentReportApiUnavailableMessage,
  buildStudentReportNoScoreDataMessage,
} from '../messages';
export {
  buildFallbackReport,
  formatReport,
  parseReportOutput,
} from '../report-formatter';
