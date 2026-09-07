import type { DataSource } from 'typeorm';
import { NotificationPreferenceService } from './notification-preference.service';

describe('NotificationPreferenceService.findReportOptedInUserIds', () => {
  let queryMock: jest.Mock;
  let service: NotificationPreferenceService;

  beforeEach(() => {
    queryMock = jest.fn();
    service = new NotificationPreferenceService({
      query: queryMock,
    } as unknown as DataSource);
  });

  it('returns the set of opted-in user ids from one batch query', async () => {
    queryMock.mockResolvedValue([{ user_id: 2 }, { user_id: 7 }]);

    const optedIn = await service.findReportOptedInUserIds([1, 2, 7]);

    expect(optedIn).toEqual(new Set([2, 7]));
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('report_enabled');
    expect(sql).toContain('COALESCE');
    expect(sql).toContain('= ANY');
    expect(params).toEqual([[1, 2, 7]]);
  });

  it('returns an empty set without querying when the input is empty', async () => {
    const optedIn = await service.findReportOptedInUserIds([]);

    expect(optedIn).toEqual(new Set());
    expect(queryMock).not.toHaveBeenCalled();
  });
});
