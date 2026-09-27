import { PrivacyStateService } from './privacy-state.service';

describe('PrivacyStateService — pending-action TTL', () => {
  type ConfirmablePrivacyIntent = 'unlink' | 'delete' | 'export';

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const confirmationPhrases: Array<[ConfirmablePrivacyIntent, string]> = [
    ['unlink', 'Đồng ý ngắt kết nối'],
    ['delete', 'Đồng ý xóa dữ liệu'],
    ['export', 'Đồng ý tải dữ liệu'],
  ];

  it.each(confirmationPhrases)(
    'explains the deliberate confirmation for %s',
    (intent, phrase) => {
      expect(
        new PrivacyStateService().setPendingAction(
          'psid-1',
          'messenger',
          intent,
        ),
      ).toContain(phrase);
    },
  );

  it('honors a custom ttlMs', () => {
    const svc = new PrivacyStateService(1_000);
    svc.setPendingAction('psid-1', 'messenger', 'delete');

    jest.setSystemTime(Date.now() + 900);
    expect(svc.getPendingAction('psid-1', 'messenger')).toBe('delete');

    jest.setSystemTime(Date.now() + 200);
    expect(svc.getPendingAction('psid-1', 'messenger')).toBeNull();
  });

  it('drops pending action when linked learner changes', () => {
    const svc = new PrivacyStateService();
    svc.setPendingAction('psid-1', 'messenger', 'delete', { userId: 42 });

    expect(svc.getPendingAction('psid-1', 'messenger', { userId: 42 })).toBe(
      'delete',
    );
    svc.setPendingAction('psid-1', 'messenger', 'delete', { userId: 42 });
    expect(
      svc.getPendingAction('psid-1', 'messenger', { userId: 43 }),
    ).toBeNull();
    expect(
      svc.getPendingAction('psid-1', 'messenger', { userId: 42 }),
    ).toBeNull();
  });

  it('drops pending action when the mapping generation changes', () => {
    const svc = new PrivacyStateService();
    svc.setPendingAction('psid-1', 'messenger', 'delete', {
      userId: 42,
      mappingGeneration: '3',
    });

    expect(
      svc.getPendingAction('psid-1', 'messenger', {
        userId: 42,
        mappingGeneration: '3',
      }),
    ).toBe('delete');

    // Same learner, new generation after a relink — pending is gone.
    expect(
      svc.getPendingAction('psid-1', 'messenger', {
        userId: 42,
        mappingGeneration: '4',
      }),
    ).toBeNull();
    expect(
      svc.getPendingAction('psid-1', 'messenger', {
        userId: 42,
        mappingGeneration: '3',
      }),
    ).toBeNull();
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
