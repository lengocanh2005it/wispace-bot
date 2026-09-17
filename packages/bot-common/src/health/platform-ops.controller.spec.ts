import { HttpStatus, RequestMethod } from '@nestjs/common';
import {
  PlatformOpsController,
  type PlatformOpsHandlers,
  PrivacyActionBody,
} from './platform-ops.controller';

class TestOpsController extends PlatformOpsController {
  public constructor(handlers: PlatformOpsHandlers) {
    super(handlers);
  }
}

const handlers = {
  sendReports: jest.fn(),
  syncStudyReminders: jest.fn(),
  unlinkUser: jest.fn(),
  deleteUser: jest.fn(),
  exportUser: jest.fn(),
  clearClarification: jest.fn(),
};

describe('PlatformOpsController', () => {
  const controller = new TestOpsController(handlers);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('delegates shared ops actions', async () => {
    const reportBody = { forceSend: true };

    controller.sendReports(reportBody);
    controller.syncStudyReminders();
    controller.unlinkUser({ externalUserId: 'u1' });
    controller.deleteUser({ externalUserId: 'u2' });
    controller.exportUser({ externalUserId: 'u3' });
    controller.clearClarificationState({ externalUserId: 'u4' });

    expect(handlers.sendReports).toHaveBeenCalledWith(reportBody);
    expect(handlers.syncStudyReminders).toHaveBeenCalledWith();
    expect(handlers.unlinkUser).toHaveBeenLastCalledWith('u1', undefined);
    expect(handlers.deleteUser).toHaveBeenLastCalledWith('u2', undefined);
    expect(handlers.exportUser).toHaveBeenLastCalledWith('u3');
    expect(handlers.clearClarification).toHaveBeenLastCalledWith('u4');
  });

  it('binds the shared routes and status codes', () => {
    const routes = [
      ['sendReports', 'send-reports', RequestMethod.POST, HttpStatus.OK],
      [
        'syncStudyReminders',
        'sync-study-reminders',
        RequestMethod.POST,
        HttpStatus.OK,
      ],
      [
        'clearClarificationState',
        'ops/clarification/clear',
        RequestMethod.POST,
        HttpStatus.NO_CONTENT,
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

  it('forwards the expected mapping fence to both privacy mutations', async () => {
    const expectedMapping = {
      exists: true,
      userId: 42,
      mappingGeneration: '7',
    };

    await controller.unlinkUser({ externalUserId: 'u1', expectedMapping });
    await controller.deleteUser({ externalUserId: 'u2', expectedMapping });

    expect(handlers.unlinkUser).toHaveBeenCalledWith('u1', expectedMapping);
    expect(handlers.deleteUser).toHaveBeenCalledWith('u2', expectedMapping);
  });

  it('maps durable privacy outcomes to HTTP status without changing the body', async () => {
    const response = { status: jest.fn() };
    const incomplete = {
      deleted: true,
      status: 'incomplete' as const,
      cleanupId: 'opaque-cleanup-id',
      outstandingStores: ['chat_history'],
    };
    handlers.unlinkUser.mockResolvedValueOnce(incomplete);

    await expect(
      controller.unlinkUser({ externalUserId: 'u1' }, response),
    ).resolves.toBe(incomplete);
    expect(response.status).toHaveBeenCalledWith(202);

    handlers.deleteUser.mockResolvedValueOnce({
      deleted: false,
      conflict: true,
    });
    await controller.deleteUser({ externalUserId: 'u2' }, response);
    expect(response.status).toHaveBeenLastCalledWith(409);
  });
});
