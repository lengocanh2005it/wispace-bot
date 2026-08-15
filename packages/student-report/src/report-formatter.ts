import type { StudentCapacityInput, StudentCapacityReport } from './types';

/**
 * LLM-written portion of the report. Factual fields (streak, task statuses,
 * dates, counts, bands) are deliberately NOT part of the model contract —
 * they are generated deterministically from source data (issue #124), so a
 * hallucinated/injected number can never reach the student.
 */
export interface StudentReportProse {
  headline: string;
}

function parseJsonObject(content: string): Record<string, unknown> {
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('LLM JSON output must be an object');
  }

  return parsed as Record<string, unknown>;
}

function readRequiredStringField(
  value: Record<string, unknown>,
  key: string,
  options?: { maxChars?: number; sanitize?: (raw: string) => string },
): string {
  const raw = value[key];
  if (typeof raw !== 'string') {
    throw new Error(`LLM JSON output missing string field: ${key}`);
  }

  const sanitize = options?.sanitize ?? ((text: string) => text);
  const text = sanitize(raw).replace(/\s+/g, ' ').trim();
  if (!text) {
    throw new Error(`LLM JSON output has empty string field: ${key}`);
  }

  const maxChars = options?.maxChars ?? 600;
  return text.length > maxChars ? `${text.slice(0, maxChars).trim()}...` : text;
}

/**
 * Parses the LLM's JSON report output. The model may only produce prose
 * (`headline`); any other key (e.g. old `streak`/`tình trạng task X` fields)
 * is ignored — factual content is built from source data by `buildReport`.
 * `sanitizeText` lets each platform strip Markdown or other formatting it
 * can't render (Messenger strips it; Discord/Zalo may not need to).
 */
export function parseReportOutput(
  content: string,
  sanitizeText?: (raw: string) => string,
): StudentReportProse {
  const parsed = parseJsonObject(content);
  return {
    headline: readRequiredStringField(parsed, 'headline', {
      sanitize: sanitizeText,
    }),
  };
}

/** Deterministic factual headline from source data (exam date / days left). */
export function buildFactualHeadline(input: StudentCapacityInput): string {
  if (input.exam_has_passed) {
    return `Kỳ thi ngày ${input.exam_date_display} đã qua. Mục tiêu band ${input.target_band} — hãy xem lại tiến độ và lên kế hoạch tiếp theo.`;
  }
  if (input.days_until_exam === 0) {
    return `Hôm nay là ngày thi ${input.exam_date_display}, mục tiêu band ${input.target_band}.`;
  }
  return `Bạn còn ${input.days_until_exam} ngày nữa đến kỳ thi ${input.exam_date_display}, mục tiêu band ${input.target_band}.`;
}

/** Deterministic factual fields from source data — never model-provided. */
export function buildFactualFields(
  input: StudentCapacityInput,
): Pick<
  StudentCapacityReport,
  'streak' | 'tình trạng task 2' | 'tình trạng task 1'
> {
  return {
    streak: `Bạn đã làm ${input.total_essays_task1} bài Task 1 và ${input.total_essays_task2} bài Task 2.`,
    'tình trạng task 2': `Task 2 đang ở band ${input.task2_band} — khả năng lập luận tốt.`,
    'tình trạng task 1': `Task 1 đang ở band ${input.task1_band}, thấp hơn mục tiêu ${(
      input.target_band - input.task1_band
    ).toFixed(1)} band — cần luyện mô tả biểu đồ.`,
  };
}

/**
 * Combines the LLM's prose headline with the deterministic factual fields.
 * The factual headline line is always included first, so no model output can
 * contradict the source data (issue #124).
 */
export function buildReport(
  prose: StudentReportProse,
  input: StudentCapacityInput,
): StudentCapacityReport {
  const factualHeadline = buildFactualHeadline(input);
  return {
    headline: [factualHeadline, prose.headline.trim()]
      .filter(Boolean)
      .join('\n'),
    ...buildFactualFields(input),
  };
}

/** Deterministic report used when the LLM is unavailable or returns invalid output. */
export function buildFallbackReport(
  input: StudentCapacityInput,
): StudentCapacityReport {
  return {
    headline: buildFactualHeadline(input),
    ...buildFactualFields(input),
  };
}

export function formatReport(report: StudentCapacityReport): string {
  return [
    report.headline,
    '',
    report.streak,
    '',
    report['tình trạng task 2'],
    report['tình trạng task 1'],
  ].join('\n');
}
