import * as adapters from './adapters';
import * as core from './core';

describe('ops-health package boundaries', () => {
  it('keeps health/data-quality policy in core and infrastructure in adapters', () => {
    expect(core.DataQualityService).toBeDefined();
    expect(core.evaluateDataQualityCheck).toBeDefined();
    expect(core.OpsHealthService).toBeUndefined();
    expect(core.readDataQualityConfig).toBeUndefined();
    expect(core.TypeormOpsHealthRepository).toBeUndefined();

    expect(adapters.OpsHealthService).toBeDefined();
    expect(adapters.readDataQualityConfig).toBeDefined();
    expect(adapters.TypeormOpsHealthRepository).toBeDefined();
    expect(adapters.OpsHealthModule).toBeDefined();
  });
});
