/* eslint-disable @typescript-eslint/no-unsafe-assignment -- typed mocks for port seams */
import {
  ZaloLinkCompletionService,
  ZaloLinkTokenRejectedError,
} from './zalo-link-completion.service';
import type { ZaloAccountLinkService } from './zalo-account-link.service';
import type { WispaceTokenVerifyService } from '@wispace/wispace-client';
import type { ZaloLinkVerifyRecordRepositoryPort } from '../domain/ports/zalo-link-verify-record.repository.port';

describe('ZaloLinkCompletionService', () => {
  const buildService = (
    overrides: {
      verifyResult?: { valid: boolean; userId?: number };
      upsertError?: Error;
      upsertFailures?: number;
      clearClarificationState?: jest.Mock;
    } = {},
  ) => {
    const exchangeCodeForZaloUser = jest
      .fn()
      .mockResolvedValue({ id: 'zalo-user-1', name: 'A' });
    const verifyToken = jest
      .fn()
      .mockResolvedValue(overrides.verifyResult ?? { valid: true, userId: 42 });
    const upsertLink = jest.fn();
    if (overrides.upsertError) {
      upsertLink.mockRejectedValue(overrides.upsertError);
    } else {
      upsertLink.mockResolvedValue(undefined);
    }
    const accountLinkService = {
      exchangeCodeForZaloUser,
      upsertLink,
      findUserIdByZaloId: jest.fn(),
      sendConsentExplainerIfDue: jest.fn().mockResolvedValue(true),
    } as unknown as ZaloAccountLinkService;
    const tokenVerifyService = {
      verifyToken,
    } as unknown as WispaceTokenVerifyService;
    const recordVerify = jest.fn().mockResolvedValue(undefined);
    const consumeRecord = jest.fn().mockResolvedValue(undefined);
    const verifyRecordService = {
      recordVerify,
      consumeRecord,
      listStaleRecords: jest.fn(),
      findPending: jest.fn(),
    } as unknown as ZaloLinkVerifyRecordRepositoryPort;
    const sendText = jest.fn().mockResolvedValue(undefined);
    const outboundService = { sendText } as never;
    const clarificationStateStore = {
      clear:
        overrides.clearClarificationState ?? jest.fn().mockResolvedValue(true),
    };

    const service = new ZaloLinkCompletionService(
      accountLinkService,
      tokenVerifyService,
      verifyRecordService,
      outboundService,
      clarificationStateStore,
    );
    return {
      service,
      exchangeCodeForZaloUser,
      verifyToken,
      upsertLink,
      recordVerify,
      consumeRecord,
      sendText,
      clarificationStateStore,
      accountLinkService,
    };
  };

  it('records a durable verify intent BEFORE the mapping upsert (#147)', async () => {
    const {
      service,
      recordVerify,
      upsertLink,
      sendText,
      consumeRecord,
      clarificationStateStore,
    } = buildService();

    await service.completeLink('code-1', 'verifier-1', 'link-token');

    // WISPACE consumed the token during verify — the intent is persisted
    // before the upsert so a crash in between can be reconciled.
    expect(recordVerify.mock.invocationCallOrder[0]).toBeLessThan(
      upsertLink.mock.invocationCallOrder[0],
    );
    expect(recordVerify).toHaveBeenCalledWith('zalo-user-1', 42);
    expect(upsertLink).toHaveBeenCalledWith(42, 'zalo-user-1');
    expect(consumeRecord).toHaveBeenCalledWith('zalo-user-1');
    // Welcome AFTER the mapping is committed.
    expect(sendText.mock.invocationCallOrder[0]).toBeGreaterThan(
      upsertLink.mock.invocationCallOrder[0],
    );
    expect(clarificationStateStore.clear).toHaveBeenCalledWith(
      'zalo:zalo-user-1',
    );
  });

  it('retries the upsert on transient failure (token already consumed — must commit)', async () => {
    const upsertLink = jest
      .fn()
      .mockRejectedValueOnce(new Error('DB down'))
      .mockResolvedValueOnce(undefined);
    const accountLinkService = {
      exchangeCodeForZaloUser: jest.fn().mockResolvedValue({ id: 'zalo-1' }),
      upsertLink,
      sendConsentExplainerIfDue: jest.fn().mockResolvedValue(true),
    } as unknown as ZaloAccountLinkService;
    const verifyRecordService = {
      recordVerify: jest.fn().mockResolvedValue(undefined),
      consumeRecord: jest.fn().mockResolvedValue(undefined),
    } as unknown as ZaloLinkVerifyRecordRepositoryPort;

    const service = new ZaloLinkCompletionService(
      accountLinkService,
      {
        verifyToken: jest.fn().mockResolvedValue({ valid: true, userId: 7 }),
      } as never,
      verifyRecordService,
      { sendText: jest.fn().mockResolvedValue(undefined) } as never,
      { clear: jest.fn().mockResolvedValue(true) },
    );

    await service.completeLink('code-1', 'verifier-1', 'token');

    expect(upsertLink).toHaveBeenCalledTimes(2);
  });

  it('throws ZaloLinkTokenRejectedError when the token is invalid — no intent recorded', async () => {
    const { service, recordVerify, upsertLink } = buildService({
      verifyResult: { valid: false },
    });

    await expect(
      service.completeLink('code-1', 'verifier-1', 'bad-token'),
    ).rejects.toBeInstanceOf(ZaloLinkTokenRejectedError);
    expect(recordVerify).not.toHaveBeenCalled();
    expect(upsertLink).not.toHaveBeenCalled();
  });
  it('succeeds even if the welcome outbound message delivery fails (best-effort)', async () => {
    const { service, upsertLink, sendText } = buildService();
    sendText.mockRejectedValueOnce(new Error('Zalo API 500'));

    await expect(
      service.completeLink('code-1', 'verifier-1', 'link-token'),
    ).resolves.toBeUndefined();

    expect(upsertLink).toHaveBeenCalledWith(42, 'zalo-user-1');
    expect(sendText).toHaveBeenCalled();
  });
  it('completes successfully and does not throw when outbound welcome times out', async () => {
    const { service, upsertLink, sendText } = buildService();
    sendText.mockRejectedValueOnce(new Error('Request timeout'));

    await expect(
      service.completeLink('code-1', 'verifier-1', 'link-token'),
    ).resolves.toBeUndefined();

    expect(upsertLink).toHaveBeenCalledWith(42, 'zalo-user-1');
  });

  it('attempts the consent explainer after the link commits (#596)', async () => {
    const { service, accountLinkService, upsertLink } = buildService();

    await service.completeLink('code-1', 'verifier-1', 'token-1');

    const order = (accountLinkService.sendConsentExplainerIfDue as jest.Mock)
      .mock.invocationCallOrder[0];
    expect(order).toBeGreaterThan(upsertLink.mock.invocationCallOrder[0]);
    expect(accountLinkService.sendConsentExplainerIfDue).toHaveBeenCalledWith(
      'zalo-user-1',
      expect.any(Function),
    );
  });
});
