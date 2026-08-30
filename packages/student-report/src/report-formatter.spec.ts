import {
  buildFallbackReport,
  buildReport,
  formatReport,
  parseReportOutput,
} from './report-formatter';
import type { StudentCapacityInput } from './types';

const baseInput: StudentCapacityInput = {
  exam_date: '2026-08-01',
  exam_date_display: '01/08/2026',
  current_date: '2026-07-01',
  days_until_exam: 31,
  exam_has_passed: false,
  target_band: 7,
  task1_band: 6,
  task2_band: 6.5,
  total_essays_task1: 5,
  total_essays_task2: 4,
};

describe('parseReportOutput', () => {
  it('parses the LLM prose headline and ignores any other keys', () => {
    const content = JSON.stringify({
      headline: 'Headline',
      streak: 'Fake streak 999',
      'tình trạng task 2': 'Fake T2',
      'tình trạng task 1': 'Fake T1',
    });

    expect(parseReportOutput(content)).toEqual({ headline: 'Headline' });
  });

  it('applies the sanitizeText hook when provided', () => {
    const content = JSON.stringify({ headline: '**Headline**' });

    const result = parseReportOutput(content, (raw) =>
      raw.replace(/\*\*/g, ''),
    );

    expect(result.headline).toBe('Headline');
  });

  it('throws when the headline field is missing', () => {
    const content = JSON.stringify({ streak: 'Streak' });
    expect(() => parseReportOutput(content)).toThrow(/missing string field/);
  });

  it('throws when content is not a JSON object', () => {
    expect(() => parseReportOutput('[]')).toThrow(
      'LLM JSON output must be an object',
    );
  });
});

describe('buildReport', () => {
  it('always renders deterministic factual fields, ignoring contradictory model output', () => {
    const report = buildReport({ headline: 'Cố lên nhé!' }, baseInput);

    expect(report.streak).toBe('Bạn đã làm 5 bài Task 1 và 4 bài Task 2.');
    expect(report['tình trạng task 2']).toContain('band 6.5');
    expect(report['tình trạng task 1']).toContain('band 6');
  });

  it('omits unknown facts instead of rendering fabricated zero values', () => {
    const report = buildFallbackReport({
      ...baseInput,
      exam_date: '',
      exam_date_display: '',
      target_band: null,
      task1_band: null,
      task2_band: null,
      total_essays_task1: null,
      total_essays_task2: null,
    });

    expect(report.headline).toMatch(/chưa có ngày thi/i);
    expect(report.headline).toMatch(/chưa đặt mục tiêu/i);
    expect(report.streak).toContain('Chưa đủ dữ liệu');
    expect(report['tình trạng task 1']).toMatch(/chưa có dữ liệu/i);
    expect(report['tình trạng task 2']).toMatch(/chưa có dữ liệu/i);
    expect(formatReport(report)).not.toContain('0 bài');
  });

  it('prepends the deterministic factual headline to the LLM prose', () => {
    const report = buildReport({ headline: 'Cố lên nhé!' }, baseInput);

    expect(report.headline).toContain('còn 31 ngày');
    expect(report.headline).toContain('Cố lên nhé!');
  });
});

describe('buildFallbackReport', () => {
  it('builds an upcoming-exam headline', () => {
    const report = buildFallbackReport(baseInput);
    expect(report.headline).toContain('còn 31 ngày');
  });

  it('builds an exam-day headline', () => {
    const report = buildFallbackReport({ ...baseInput, days_until_exam: 0 });
    expect(report.headline).toContain('Hôm nay là ngày thi');
  });

  it('builds a passed-exam headline', () => {
    const report = buildFallbackReport({
      ...baseInput,
      exam_has_passed: true,
    });
    expect(report.headline).toContain('đã qua');
  });
});

describe('formatReport', () => {
  it('joins report fields with blank lines', () => {
    const text = formatReport({
      headline: 'H',
      streak: 'S',
      'tình trạng task 2': 'T2',
      'tình trạng task 1': 'T1',
    });

    expect(text).toBe('H\n\nS\n\nT2\nT1');
  });
});
