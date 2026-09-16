import * as adapters from './adapters';
import * as core from './core';

const coreExports = core as Record<string, unknown>;

describe('ops-health package boundaries', () => {
  it('keeps health/data-quality policy in core and infrastructure in adapters', () => {
    expect(core.DataQualityService).toBeDefined();
    expect(core.evaluateDataQualityCheck).toBeDefined();
    expect(coreExports.OpsHealthService).toBeUndefined();
    expect(coreExports.readDataQualityConfig).toBeUndefined();
    expect(coreExports.TypeormOpsHealthRepository).toBeUndefined();

    expect(adapters.OpsHealthService).toBeDefined();
    expect(adapters.readDataQualityConfig).toBeDefined();
    expect(adapters.TypeormOpsHealthRepository).toBeDefined();
    expect(adapters.OpsHealthModule).toBeDefined();
  });
});
