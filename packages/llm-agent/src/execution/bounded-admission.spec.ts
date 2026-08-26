import {
  BoundedAdmissionQueue,
  admissionWaitBudgetMs,
} from './bounded-admission';

describe('BoundedAdmissionQueue', () => {
  it('grants an immediate slot when under concurrency', async () => {
    const queue = new BoundedAdmissionQueue(2, 5);

    const ticket = await queue.acquire();

    expect(queue.activeCount).toBe(1);
    ticket.release();
    expect(queue.activeCount).toBe(0);
  });

  it('queues waiters beyond concurrency and grants FIFO on release', async () => {
    const queue = new BoundedAdmissionQueue(1, 5);
    const first = await queue.acquire();
    const order: number[] = [];

    const second = queue.acquire().then((t) => {
      order.push(2);
      return t;
    });
    const third = queue.acquire().then((t) => {
      order.push(3);
      return t;
    });
    expect(queue.waitingCount).toBe(2);

    first.release();
    (await second).release();
    (await third).release();

    expect(order).toEqual([2, 3]);
    expect(queue.activeCount).toBe(0);
  });

  it('rejects with a typed overload error when the queue is full', async () => {
    const queue = new BoundedAdmissionQueue(1, 1);
    const held = await queue.acquire();
    const queued = queue.acquire(); // fills the single queue slot (pending)

    await expect(queue.acquire()).rejects.toMatchObject({
      name: 'LlmOverloadError',
      reason: 'queue_full',
    });

    held.release();
    (await queued).release();
    expect(queue.activeCount).toBe(0);
  });

  it('rejects with wait_timeout when the budget expires while queued', async () => {
    jest.useFakeTimers();
    try {
      const queue = new BoundedAdmissionQueue(1, 5);
      const held = await queue.acquire();
      const queued = queue.acquire({ waitBudgetMs: 50 });

      jest.advanceTimersByTime(60);

      await expect(queued).rejects.toMatchObject({
        name: 'LlmOverloadError',
        reason: 'wait_timeout',
      });
      held.release();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects with AbortError when the caller aborts while queued', async () => {
    const queue = new BoundedAdmissionQueue(1, 5);
    const held = await queue.acquire();
    const controller = new AbortController();
    const queued = queue.acquire({ signal: controller.signal });

    controller.abort();

    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    held.release();
  });

  it('does not grant the slot to an abandoned waiter that timed out', async () => {
    jest.useFakeTimers();
    try {
      const queue = new BoundedAdmissionQueue(1, 5);
      const held = await queue.acquire();
      const stale = queue
        .acquire({ waitBudgetMs: 10 })
        .catch(() => 'timed-out');
      const fresh = queue.acquire();

      jest.advanceTimersByTime(20);
      await stale;
      held.release();

      const ticket = await fresh;
      expect(queue.activeCount).toBe(1);
      ticket.release();
      expect(queue.activeCount).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('ignores double release', async () => {
    const queue = new BoundedAdmissionQueue(1, 5);
    const ticket = await queue.acquire();

    ticket.release();
    expect(() => ticket.release()).not.toThrow();
    expect(queue.activeCount).toBe(0);
  });
});

describe('admissionWaitBudgetMs', () => {
  const config = { chatAdmissionWaitMs: 8000, backgroundAdmissionWaitMs: 1500 };

  it('gives interactive chat the full budget', () => {
    expect(admissionWaitBudgetMs(config, 'FREE_FORM_CHAT')).toBe(8000);
  });

  it('sheds background features early', () => {
    expect(admissionWaitBudgetMs(config, 'STUDENT_REPORT')).toBe(1500);
    expect(admissionWaitBudgetMs(config, 'STUDY_REMINDER')).toBe(1500);
  });

  it('defaults unknown features to the background budget', () => {
    expect(admissionWaitBudgetMs(config)).toBe(1500);
  });
});
