import { LlmOverloadError } from './bounded-admission';
import {
  LlmAdmissionCoordinator,
  type LlmAdmissionGlobalPort,
} from './llm-admission-coordinator';

const config = {
  enabled: true,
  maxConcurrent: 1,
  maxQueueDepth: 5,
  chatAdmissionWaitMs: 8_000,
  backgroundAdmissionWaitMs: 1_500,
  globalMaxConcurrent: 1,
  globalConcurrencyEnabled: true,
  globalAcquireMaxRetries: 4,
  globalAcquireRetryDelayMs: 10_000,
};

const logger = { warn: jest.fn() };

describe('LlmAdmissionCoordinator', () => {
  it('releases the local permit before retrying a saturated global probe', async () => {
    let firstProbeSeen!: () => void;
    const probeSeen = new Promise<void>((resolve) => {
      firstProbeSeen = resolve;
    });
    let probes = 0;
    const releaseGlobal = jest.fn().mockResolvedValue(undefined);
    const global: LlmAdmissionGlobalPort = {
      acquire: jest.fn(async () => {
        probes += 1;
        if (probes === 1) {
          firstProbeSeen();
          throw new LlmOverloadError('global_saturated');
        }
        return releaseGlobal;
      }),
    };
    const metrics = {
      incrementCounter: jest.fn(),
      observeWaitSeconds: jest.fn(),
      observeActiveCapacity: jest.fn(),
    };
    const coordinator = new LlmAdmissionCoordinator(
      config,
      logger,
      metrics,
      global,
    );

    const firstController = new AbortController();
    const first = coordinator.acquire('FREE_FORM_CHAT', firstController.signal);
    await probeSeen;
    await new Promise<void>((resolve) => setImmediate(resolve));

    const second = coordinator.acquire('FREE_FORM_CHAT');
    await Promise.resolve();
    expect(metrics.observeActiveCapacity).toHaveBeenCalledWith(0, 1);

    firstController.abort(new Error('stop test probe'));
    await expect(first).rejects.toThrow('stop test probe');
    const secondLease = await second;
    await secondLease.release();
    expect(global.acquire).toHaveBeenCalledTimes(2);
    expect(releaseGlobal).toHaveBeenCalledTimes(1);
  });

  it('fails closed when global concurrency is enabled without a global port', () => {
    expect(
      () => new LlmAdmissionCoordinator(config, logger, undefined, undefined),
    ).toThrow(/aggregate limit/i);
  });

  it('keeps local and global waits in one admission budget', async () => {
    jest.useFakeTimers();
    try {
      const global: LlmAdmissionGlobalPort = {
        acquire: jest
          .fn()
          .mockRejectedValue(new LlmOverloadError('global_saturated')),
      };
      const coordinator = new LlmAdmissionCoordinator(
        {
          ...config,
          chatAdmissionWaitMs: 20,
          globalAcquireRetryDelayMs: 20,
        },
        logger,
        undefined,
        global,
      );

      const pending = coordinator.acquire('FREE_FORM_CHAT');
      await Promise.resolve();
      jest.advanceTimersByTime(100);

      await expect(pending).rejects.toMatchObject({
        name: 'LlmOverloadError',
        reason: 'global_saturated',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries transient Redis outages across released probes', async () => {
    let attempts = 0;
    const releaseGlobal = jest.fn().mockResolvedValue(undefined);
    const global: LlmAdmissionGlobalPort = {
      acquire: jest.fn(async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new LlmOverloadError('redis_unavailable');
        }
        return releaseGlobal;
      }),
    };
    const coordinator = new LlmAdmissionCoordinator(
      {
        ...config,
        globalAcquireRetryDelayMs: 0,
      },
      logger,
      undefined,
      global,
    );

    const lease = await coordinator.acquire('FREE_FORM_CHAT');
    await lease.release();
    expect(global.acquire).toHaveBeenCalledTimes(3);
    expect(releaseGlobal).toHaveBeenCalledTimes(1);
  });

  it('records one terminal rejection instead of one rejection per probe', async () => {
    const incrementCounter = jest.fn();
    const global: LlmAdmissionGlobalPort = {
      acquire: jest.fn(async (_limit, _logger, options) => {
        options?.metrics?.incrementCounter('llm_admission_rejected_total', {
          reason: 'global_saturated',
        });
        throw new LlmOverloadError('global_saturated');
      }),
    };
    const coordinator = new LlmAdmissionCoordinator(
      {
        ...config,
        globalAcquireMaxRetries: 2,
        globalAcquireRetryDelayMs: 0,
      },
      logger,
      { incrementCounter, observeWaitSeconds: jest.fn() },
      global,
    );

    await expect(coordinator.acquire('FREE_FORM_CHAT')).rejects.toMatchObject({
      reason: 'global_saturated',
    });
    expect(incrementCounter).toHaveBeenCalledTimes(1);
    expect(incrementCounter).toHaveBeenCalledWith(
      'llm_admission_rejected_total',
      { reason: 'global_saturated' },
    );
  });
});
