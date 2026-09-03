import { PrivacyStateService } from './privacy-state.service';

describe('PrivacyStateService — pending-action TTL', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('honors a custom ttlMs', () => {
    const svc = new PrivacyStateService(1_000);
    svc.setPendingAction('psid-1', 'messenger', 'delete');

    jest.setSystemTime(Date.now() + 900);
    expect(svc.getPendingAction('psid-1', 'messenger')).toBe('delete');

    jest.setSystemTime(Date.now() + 200);
    expect(svc.getPendingAction('psid-1', 'messenger')).toBeNull();
  });

  it('falls back to the 30-minute default when ttlMs is invalid or omitted', () => {
    for (const svc of [
      new PrivacyStateService(),
      new PrivacyStateService(-5),
      new PrivacyStateService(Number.NaN),
    ]) {
      svc.setPendingAction('psid-1', 'messenger', 'delete');

      jest.setSystemTime(Date.now() + 29 * 60 * 1000);
      expect(svc.getPendingAction('psid-1', 'messenger')).toBe('delete');

      jest.setSystemTime(Date.now() + 2 * 60 * 1000);
      expect(svc.getPendingAction('psid-1', 'messenger')).toBeNull();
    }
  });
});
