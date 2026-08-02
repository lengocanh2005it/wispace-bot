import {
  ExecutionContext,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildMessengerWebhookSignatureHeader } from '../utils/messenger-webhook-signature.utils';
import { MessengerWebhookSignatureGuard } from './messenger-webhook-signature.guard';

describe('MessengerWebhookSignatureGuard', () => {
  const body = JSON.stringify({ object: 'page', entry: [] });
  const secret = 'test-app-secret';

  const createContext = (params: {
    rawBody?: Buffer;
    signatureHeader?: string;
  }): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          rawBody: params.rawBody,
          header: (name: string) =>
            name.toLowerCase() === 'x-hub-signature-256'
              ? params.signatureHeader
              : undefined,
        }),
      }),
    }) as ExecutionContext;

  it('rejects unsigned requests outside the test runtime', () => {
    const guard = new MessengerWebhookSignatureGuard({
      get: (key: string) =>
        key === 'MESSENGER_WEBHOOK_SIGNATURE_VERIFY'
          ? 'false'
          : key === 'NODE_ENV'
            ? 'development'
            : undefined,
    } as ConfigService);

    expect(() => guard.canActivate(createContext({}))).toThrow(
      InternalServerErrorException,
    );
  });

  it('allows unsigned requests only in the test runtime', () => {
    const guard = new MessengerWebhookSignatureGuard({
      get: (key: string) =>
        key === 'MESSENGER_WEBHOOK_SIGNATURE_VERIFY'
          ? 'false'
          : key === 'NODE_ENV'
            ? 'test'
            : undefined,
    } as ConfigService);

    expect(guard.canActivate(createContext({}))).toBe(true);
  });

  it('allows request with valid signature when verification is enabled', () => {
    const guard = new MessengerWebhookSignatureGuard({
      get: (key: string) => {
        if (key === 'MESSENGER_WEBHOOK_SIGNATURE_VERIFY') {
          return 'true';
        }
        if (key === 'MESSENGER_APP_SECRET') {
          return secret;
        }
        return undefined;
      },
    } as ConfigService);

    expect(
      guard.canActivate(
        createContext({
          rawBody: Buffer.from(body),
          signatureHeader: buildMessengerWebhookSignatureHeader(body, secret),
        }),
      ),
    ).toBe(true);
  });

  it('rejects invalid signature', () => {
    const guard = new MessengerWebhookSignatureGuard({
      get: (key: string) => {
        if (key === 'MESSENGER_WEBHOOK_SIGNATURE_VERIFY') {
          return 'true';
        }
        if (key === 'MESSENGER_APP_SECRET') {
          return secret;
        }
        return undefined;
      },
    } as ConfigService);

    expect(() =>
      guard.canActivate(
        createContext({
          rawBody: Buffer.from(body),
          signatureHeader: 'sha256=invalid',
        }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('requires app secret when verification is enabled', () => {
    const guard = new MessengerWebhookSignatureGuard({
      get: (key: string) =>
        key === 'MESSENGER_WEBHOOK_SIGNATURE_VERIFY' ? 'true' : undefined,
    } as ConfigService);

    expect(() => guard.canActivate(createContext({}))).toThrow(
      InternalServerErrorException,
    );
  });
});
