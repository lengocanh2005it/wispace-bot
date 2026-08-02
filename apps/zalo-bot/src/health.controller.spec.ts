import type { DataSource } from 'typeorm';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('returns status ok when database is connected', async () => {
    const query = jest.fn().mockResolvedValue([{ '?column?': 1 }]);
    const dataSource = { query } as unknown as DataSource;
    const controller = new HealthController(dataSource);
    const result = await controller.check();
    expect(result).toEqual({ status: 'ok', database: 'connected' });
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });

  it('throws ServiceUnavailableException when database is down', async () => {
    const query = jest.fn().mockRejectedValue(new Error('connection refused'));
    const dataSource = { query } as unknown as DataSource;
    const controller = new HealthController(dataSource);
    await expect(controller.check()).rejects.toThrow();
    await expect(controller.check()).rejects.not.toThrow('connection refused');
  });
});
