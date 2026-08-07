export {
  StudentReportCore,
  type StudentReportConfig,
  type StudentReportPorts,
} from './student-report.service';
export type { CapacityDataPort } from './ports';
export type { StudentCapacityInput, StudentCapacityReport } from './types';
export {
  StudentReportNoScoreDataError,
  StudentReportRetryableError,
  type RetryableApiError,
} from './errors';
export {
  buildStudentReportApiRetryMessage,
  buildStudentReportApiUnavailableMessage,
  buildStudentReportNoScoreDataMessage,
} from './messages';
export {
  buildFallbackReport,
  formatReport,
  parseReportOutput,
} from './report-formatter';
export { PlatformStudentReportService } from './platform-student-report.service';
export {
  createPlatformStudentReportServiceProvider,
  type CreatePlatformStudentReportServiceOptions,
} from './platform-student-report.provider';
