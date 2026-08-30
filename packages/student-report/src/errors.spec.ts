import { LlmProviderCircuitOpenError } from '@wispace/llm-agent/execution';
import { isStudentReportRetryableError } from './errors';

describe('isStudentReportRetryableError', () => {
  it('keeps provider circuit-open failures on the durable retry path', () => {
    expect(
      isStudentReportRetryableError(new LlmProviderCircuitOpenError()),
    ).toBe(true);
  });
});
