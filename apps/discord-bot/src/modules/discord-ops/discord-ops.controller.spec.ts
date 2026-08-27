import { HttpStatus, RequestMethod } from '@nestjs/common';
import { InternalApiKeyGuard } from '@wispace/bot-common/guard';
import { DiscordOpsController } from './discord-ops.controller';

describe('DiscordOpsController ops clarification recovery', () => {
  const mockClarificationAgent = {
    clearClarificationState: jest.fn().mockResolvedValue(undefined),
  };

  const controller = new DiscordOpsController(
    {} as never,
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
    const guards = Reflect.getMetadata('__guards__', DiscordOpsController);
    expect(guards).toContain(InternalApiKeyGuard);
  });

  it('binds POST ops/clarification/clear with 204 No Content', () => {
    const handler = DiscordOpsController.prototype.clearClarificationState;
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
      externalUserId: 'discord-user-123',
    });

    expect(mockClarificationAgent.clearClarificationState).toHaveBeenCalledWith(
      'discord-user-123',
    );
    expect(result).toBeUndefined();
  });
});
