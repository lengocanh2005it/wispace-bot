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
    /** Stable delivery key for crash-safe deduplication (#294). */
    deliveryKey?: string;
  }): Promise<ReportDeliveryResult>;
}

export const REPORT_DELIVERY_METRICS = Symbol('REPORT_DELIVERY_METRICS');

/** Report-delivery SLO outcomes (#829) — satisfied by BotMetricsService. */
export interface ReportDeliveryMetrics {
  incReportDelivery(status: string): void;
}
