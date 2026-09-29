import { HttpStatus, RequestMethod } from '@nestjs/common';
import { InternalApiKeyGuard } from '@wispace/bot-common/guard';
import { MessengerOpsController } from './messenger-ops.controller';

describe('MessengerOpsController ops clarification recovery', () => {
  const mockClarificationAgent = {
    clearClarificationState: jest.fn().mockResolvedValue(undefined),
  };

  const controller = new MessengerOpsController(
    {} as never,
    {} as never,
    mockClarificationAgent as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is protected by InternalApiKeyGuard at controller level', () => {
    const guards = Reflect.getMetadata('__guards__', MessengerOpsController);
    expect(guards).toContain(InternalApiKeyGuard);
  });

  // The routes kept the `messenger` path prefix, so the URL is unchanged from
  // when these handlers lived on SchedulerController (#1446).
  it('binds POST ops/clarification/clear with 204 No Content', () => {
    const handler = MessengerOpsController.prototype.clearClarificationState;
    expect(Reflect.getMetadata('path', handler)).toBe(
      'ops/clarification/clear',
    );
    expect(Reflect.getMetadata('method', handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata('__httpCode__', handler)).toBe(
      HttpStatus.NO_CONTENT,
    );
  });

  it('delegates to clarificationAgent with the provided externalUserId and returns no state body', async () => {
    const result = await controller.clearClarificationState({
      externalUserId: 'psid-recovery-123',
    });

    expect(mockClarificationAgent.clearClarificationState).toHaveBeenCalledWith(
      'psid-recovery-123',
    );
    expect(result).toBeUndefined();
  });
});
