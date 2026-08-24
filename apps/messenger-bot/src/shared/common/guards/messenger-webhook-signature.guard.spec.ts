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
    timestampHeader?: string;
  }): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          rawBody: params.rawBody,
          header: (name: string) => {
            const lower = name.toLowerCase();
            if (lower === 'x-hub-signature-256') return params.signatureHeader;
            if (lower === 'x-hub-timestamp') return params.timestampHeader;
            return undefined;
          },
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
          timestampHeader: String(Math.floor(Date.now() / 1000)),
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
          timestampHeader: String(Math.floor(Date.now() / 1000)),
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

  it('rejects missing X-Hub-Timestamp header (#350)', () => {
    const guard = new MessengerWebhookSignatureGuard({
      get: (key: string) => {
        if (key === 'MESSENGER_WEBHOOK_SIGNATURE_VERIFY') return 'true';
        if (key === 'MESSENGER_APP_SECRET') return secret;
        return undefined;
      },
    } as ConfigService);

    expect(() =>
      guard.canActivate(
        createContext({
          rawBody: Buffer.from(body),
          signatureHeader: buildMessengerWebhookSignatureHeader(body, secret),
        }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('rejects stale X-Hub-Timestamp (>5 minutes old) (#350)', () => {
    const guard = new MessengerWebhookSignatureGuard({
      get: (key: string) => {
        if (key === 'MESSENGER_WEBHOOK_SIGNATURE_VERIFY') return 'true';
        if (key === 'MESSENGER_APP_SECRET') return secret;
        return undefined;
      },
    } as ConfigService);

    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 600); // 10 minutes ago

    expect(() =>
      guard.canActivate(
        createContext({
          rawBody: Buffer.from(body),
          signatureHeader: buildMessengerWebhookSignatureHeader(body, secret),
          timestampHeader: staleTimestamp,
        }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('accepts fresh X-Hub-Timestamp within 5 minutes (#350)', () => {
    const guard = new MessengerWebhookSignatureGuard({
      get: (key: string) => {
        if (key === 'MESSENGER_WEBHOOK_SIGNATURE_VERIFY') return 'true';
        if (key === 'MESSENGER_APP_SECRET') return secret;
        return undefined;
      },
    } as ConfigService);

    const freshTimestamp = String(Math.floor(Date.now() / 1000)); // now

    expect(
      guard.canActivate(
        createContext({
          rawBody: Buffer.from(body),
          signatureHeader: buildMessengerWebhookSignatureHeader(body, secret),
          timestampHeader: freshTimestamp,
        }),
      ),
    ).toBe(true);
  });

  it('rejects non-numeric X-Hub-Timestamp (#350)', () => {
    const guard = new MessengerWebhookSignatureGuard({
      get: (key: string) => {
        if (key === 'MESSENGER_WEBHOOK_SIGNATURE_VERIFY') return 'true';
        if (key === 'MESSENGER_APP_SECRET') return secret;
        return undefined;
      },
    } as ConfigService);

    expect(() =>
      guard.canActivate(
        createContext({
          rawBody: Buffer.from(body),
          signatureHeader: buildMessengerWebhookSignatureHeader(body, secret),
          timestampHeader: 'not-a-number',
        }),
      ),
    ).toThrow(ForbiddenException);
  });
});
