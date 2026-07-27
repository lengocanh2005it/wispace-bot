import type {
  ReportDeliveryResult,
  ReportMapping,
} from '../types/report-send-job.types';

export const REPORT_DELIVERY_PORT = Symbol('REPORT_DELIVERY_PORT');

export interface ReportDeliveryPort {
  sendReport(input: {
    mapping: ReportMapping;
    reportText: string;
    reportDate: string;
  }): Promise<ReportDeliveryResult>;
}
