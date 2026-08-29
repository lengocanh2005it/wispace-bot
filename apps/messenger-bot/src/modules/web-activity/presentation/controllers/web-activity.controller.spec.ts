import { WebActivityController } from './web-activity.controller';

describe('WebActivityController', () => {
  it('records activity and increments the webhook counter', async () => {
    const recordActive = jest.fn().mockResolvedValue(undefined);
    const incWebActivityWebhookReceived = jest.fn();
    const controller = new WebActivityController(
      { recordActive } as never,
      { incWebActivityWebhookReceived } as never,
    );

    const res = await controller.record({
      userId: 42,
      activeAt: '2026-08-29T10:00:00Z',
    });

    expect(recordActive).toHaveBeenCalledWith(42, '2026-08-29T10:00:00Z');
    expect(incWebActivityWebhookReceived).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: true });
  });

  it('passes undefined activeAt straight through', async () => {
    const recordActive = jest.fn().mockResolvedValue(undefined);
    const controller = new WebActivityController(
      { recordActive } as never,
      { incWebActivityWebhookReceived: jest.fn() } as never,
    );
    await controller.record({ userId: 7 });
    expect(recordActive).toHaveBeenCalledWith(7, undefined);
  });
});
