import { HttpStatus, RequestMethod } from '@nestjs/common';
import { InternalApiKeyGuard } from '@wispace/bot-common/guard';
import { ZaloOpsController } from './zalo-ops.controller';

describe('ZaloOpsController ops clarification recovery', () => {
  const mockClarificationAgent = {
    clearClarificationState: jest.fn().mockResolvedValue(undefined),
  };

  const controller = new ZaloOpsController(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    mockClarificationAgent as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is protected by InternalApiKeyGuard at controller level', () => {
    const guards = Reflect.getMetadata('__guards__', ZaloOpsController);
    expect(guards).toContain(InternalApiKeyGuard);
  });

  it('binds POST ops/clarification/clear with 204 No Content', () => {
    const handler = ZaloOpsController.prototype.clearClarificationState;
    expect(Reflect.getMetadata('path', handler)).toBe(
      'ops/clarification/clear',
    );
    expect(Reflect.getMetadata('method', handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata('__httpCode__', handler)).toBe(
      HttpStatus.NO_CONTENT,
    );
  });

  it('does not expose the retired runtime secret sync route', () => {
    expect(ZaloOpsController.prototype).not.toHaveProperty(
      'dopplerRuntimeSync',
    );
  });

  it('delegates to clarificationAgent with the provided externalUserId and returns no state body', async () => {
    const result = await controller.clearClarificationState({
      externalUserId: 'zalo-user-123',
    });

    expect(mockClarificationAgent.clearClarificationState).toHaveBeenCalledWith(
      'zalo-user-123',
    );
    expect(result).toBeUndefined();
  });
});
