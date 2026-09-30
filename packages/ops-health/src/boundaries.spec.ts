import * as adapters from './adapters';
import * as core from './core';
import { OPS_HEALTH_SERVICE as BOT_COMMON_OPS_HEALTH_SERVICE } from '@wispace/bot-common/health';
import { OPS_HEALTH_SERVICE } from './types';

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

  // #1122. The package and bot-common each declared their own
  // `Symbol('OPS_HEALTH_SERVICE')`, so they were different tokens that only
  // matched by name, and the module bridged them with `useExisting`. Which
  // instance a consumer received therefore depended on which symbol it
  // imported, and the wrong one resolves to `undefined` through an
  // `@Optional()` parameter rather than failing loudly. bot-common is the lower
  // layer, so it owns the token and this package re-exports it.
  it('publishes the one OPS_HEALTH_SERVICE token, not a namesake', () => {
    expect(OPS_HEALTH_SERVICE).toBe(BOT_COMMON_OPS_HEALTH_SERVICE);
  });
});
