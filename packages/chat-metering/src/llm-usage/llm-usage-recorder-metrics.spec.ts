import {
  LlmUsageRecorderCore,
  toUsageRecorderMetrics,
  type RecordLlmUsageFromCompletionInput,
} from './llm-usage-recorder-core.service';

describe('toUsageRecorderMetrics (#549)', () => {
  it('maps the recorder counters onto the app metrics service', () => {
    const source = {
      incLlmMissingTokens: jest.fn(),
      incLlmUnpricedModelTokens: jest.fn(),
      incLlmUsageInsertFailure: jest.fn(),
    };

    const metrics = toUsageRecorderMetrics(source);
    metrics.incMissingTokens('FREE_FORM_CHAT');
    metrics.incUnpricedModelTokens('gpt-5.4');
    metrics.incInsertFailure('db_error');

    expect(source.incLlmMissingTokens).toHaveBeenCalledWith('FREE_FORM_CHAT');
    expect(source.incLlmUnpricedModelTokens).toHaveBeenCalledWith('gpt-5.4');
    expect(source.incLlmUsageInsertFailure).toHaveBeenCalledWith('db_error');
  });
});

describe('LlmUsageRecorderCore failure rows (#549)', () => {
  function buildCore() {
    const written: unknown[] = [];
    const core = new LlmUsageRecorderCore(
      { write: (event: unknown) => void written.push(event) },
      () => null,
      () => '2026-09-03',
    );
    return { core, written };
  }

  const base: RecordLlmUsageFromCompletionInput = {
    feature: 'FREE_FORM_CHAT',
    externalUserId: 'ext-123',
    model: 'gpt-5.4',
    response: { id: '', usage: null },
    correlationId: 'mid-1',
    toolRound: 0,
  };

  it('passes status/errorMessage through to the writer', () => {
    const { core, written } = buildCore();

    core.recordFromCompletion({
      ...base,
      status: 'error',
      errorMessage: 'execution_overload',
    });

    expect(written).toHaveLength(1);
    expect(written[0]).toEqual(
      expect.objectContaining({
        status: 'error',
        errorMessage: 'execution_overload',
        promptTokens: 0,
        completionTokens: 0,
      }),
    );
  });

  it('writes success rows without a status', () => {
    const { core, written } = buildCore();

    core.recordFromCompletion({
      ...base,
      response: {
        id: 'r',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
    });

    expect(written).toHaveLength(1);
    expect(written[0]).toEqual(expect.objectContaining({ status: undefined }));
  });

  it('counts missing tokens through the wired metrics', () => {
    const incMissingTokens = jest.fn();
    const core = new LlmUsageRecorderCore(
      { write: () => undefined },
      () => null,
      () => '2026-09-03',
      undefined,
      {
        incMissingTokens,
        incUnpricedModelTokens: jest.fn(),
        incInsertFailure: jest.fn(),
      },
    );

    core.recordFromCompletion(base);

    expect(incMissingTokens).toHaveBeenCalledWith('FREE_FORM_CHAT');
  });
});
