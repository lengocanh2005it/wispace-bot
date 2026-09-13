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

  it('does not expose the retired runtime secret sync route', () => {
    expect(DiscordOpsController.prototype).not.toHaveProperty(
      'dopplerRuntimeSync',
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

  it.each([
    ['unlinkUser', 'unlink', 'unlinked'],
    ['deleteUser', 'delete', 'deleted'],
  ] as const)(
    'forwards the %s durable outcome and maps incomplete/conflict statuses',
    async (method, operation, mutationKey) => {
      const privacyService = {
        unlink: jest.fn().mockResolvedValue({
          [mutationKey]: true,
          status: 'incomplete',
          cleanupId: 'opaque-discord-cleanup',
          outstandingStores: ['chat_history'],
        }),
        delete: jest.fn().mockResolvedValue({
          [mutationKey]: true,
          status: 'incomplete',
          cleanupId: 'opaque-discord-cleanup',
          outstandingStores: ['chat_history'],
        }),
        export: jest.fn(),
      };
      const historyService = { clear: jest.fn() };
      const queueService = { clear: jest.fn() };
      const clarificationAgent = {
        clearClarificationState: jest.fn(),
      };
      const controller = new DiscordOpsController(
        { sendScheduledReports: jest.fn() } as never,
        { syncUpcomingSessions: jest.fn() } as never,
        {} as never,
        privacyService as never,
        clarificationAgent as never,
        historyService as never,
        queueService as never,
      );
      const response = { status: jest.fn() };

      const incomplete = await controller[method](
        { externalUserId: 'discord-user-123' },
        response,
      );

      expect(response.status).toHaveBeenCalledWith(202);
      expect(incomplete).toMatchObject({
        status: 'incomplete',
        cleanupId: 'opaque-discord-cleanup',
      });
      expect(privacyService[operation]).toHaveBeenCalledWith(
        'discord',
        'discord-user-123',
        expect.objectContaining({
          platform: 'discord',
          applicableStores: [
            'chat_history',
            'chat_queue',
            'clarification_state',
          ],
        }),
      );

      privacyService[operation].mockResolvedValueOnce({
        [mutationKey]: false,
        conflict: true,
      });
      await controller[method](
        { externalUserId: 'discord-user-123' },
        response,
      );
      expect(response.status).toHaveBeenLastCalledWith(409);
    },
  );
});
