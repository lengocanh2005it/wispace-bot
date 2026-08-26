import { HttpStatus, RequestMethod } from '@nestjs/common';
import {
  PlatformOpsController,
  PrivacyActionBody,
} from './platform-ops.controller';

class TestOpsController extends PlatformOpsController<string> {}

const handlers = {
  dopplerRuntimeSync: jest.fn(),
  sendReports: jest.fn(),
  syncStudyReminders: jest.fn(),
  unlinkUser: jest.fn(),
  deleteUser: jest.fn(),
  exportUser: jest.fn(),
};

describe('PlatformOpsController', () => {
  const controller = new TestOpsController(handlers);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('delegates shared ops actions', async () => {
    const dopplerBody = 'doppler';
    const reportBody = { forceSend: true };

    controller.dopplerRuntimeSync(dopplerBody);
    controller.sendReports(reportBody);
    controller.syncStudyReminders();
    controller.unlinkUser({ externalUserId: 'u1' });
    controller.deleteUser({ externalUserId: 'u2' });
    controller.exportUser({ externalUserId: 'u3' });

    expect(handlers.dopplerRuntimeSync).toHaveBeenCalledWith(dopplerBody);
    expect(handlers.sendReports).toHaveBeenCalledWith(reportBody);
    expect(handlers.syncStudyReminders).toHaveBeenCalledWith();
    expect(handlers.unlinkUser).toHaveBeenLastCalledWith('u1');
    expect(handlers.deleteUser).toHaveBeenLastCalledWith('u2');
    expect(handlers.exportUser).toHaveBeenLastCalledWith('u3');
  });

  it('binds the shared routes and status codes', () => {
    const routes = [
      ['dopplerRuntimeSync', 'ops/doppler-sync', RequestMethod.POST, 202],
      ['sendReports', 'send-reports', RequestMethod.POST, HttpStatus.OK],
      [
        'syncStudyReminders',
        'sync-study-reminders',
        RequestMethod.POST,
        HttpStatus.OK,
      ],
      ['unlinkUser', 'privacy/unlink', RequestMethod.POST, HttpStatus.OK],
      ['deleteUser', 'privacy/delete', RequestMethod.POST, HttpStatus.OK],
      ['exportUser', 'privacy/export', RequestMethod.POST, HttpStatus.OK],
    ] as const;

    for (const [method, path, requestMethod, statusCode] of routes) {
      const handler = TestOpsController.prototype[method];
      expect(Reflect.getMetadata('path', handler)).toBe(path);
      expect(Reflect.getMetadata('method', handler)).toBe(requestMethod);
      expect(Reflect.getMetadata('__httpCode__', handler)).toBe(statusCode);
    }
  });

  it('keeps the privacy action body contract', () => {
    const body = new PrivacyActionBody();
    body.externalUserId = 'user-1';
    expect(body.externalUserId).toBe('user-1');
  });
});
