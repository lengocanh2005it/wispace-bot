import {
  ExecutionContext,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalApiKeyGuard } from './internal-api-key.guard';

describe('InternalApiKeyGuard', () => {
  const createContext = (headers: Record<string, string>): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          header: (name: string) => headers[name.toLowerCase()],
        }),
      }),
    }) as ExecutionContext;

  it('allows request with matching x-internal-api-key header', () => {
    const guard = new InternalApiKeyGuard({
      get: () => 'secret-key',
    } as unknown as ConfigService);

    expect(
      guard.canActivate(createContext({ 'x-internal-api-key': 'secret-key' })),
    ).toBe(true);
  });

  it('allows request with matching bearer token', () => {
    const guard = new InternalApiKeyGuard({
      get: () => 'secret-key',
    } as unknown as ConfigService);

    expect(
      guard.canActivate(createContext({ authorization: 'Bearer secret-key' })),
    ).toBe(true);
  });

  it('rejects request with wrong key', () => {
    const guard = new InternalApiKeyGuard({
      get: () => 'secret-key',
    } as unknown as ConfigService);

    expect(() =>
      guard.canActivate(createContext({ 'x-internal-api-key': 'wrong' })),
    ).toThrow(UnauthorizedException);
  });

  it('rejects request without a key', () => {
    const guard = new InternalApiKeyGuard({
      get: () => 'secret-key',
    } as unknown as ConfigService);

    expect(() => guard.canActivate(createContext({}))).toThrow(
      UnauthorizedException,
    );
  });

  it('throws generic error when INTERNAL_API_KEY is not configured', () => {
    const guard = new InternalApiKeyGuard({
      get: () => undefined,
    } as unknown as ConfigService);

    expect(() => guard.canActivate(createContext({}))).toThrow(
      InternalServerErrorException,
    );
    expect(() => guard.canActivate(createContext({}))).toThrow(
      'Internal authentication not configured',
    );
  });

  describe('internal auth rejection counter', () => {
    const createPort = () => ({ incRejected: jest.fn() });
    const createGuard = (
      port: { incRejected: jest.Mock } | undefined,
      key?: string,
    ) =>
      new InternalApiKeyGuard(
        { get: () => key } as unknown as ConfigService,
        port,
      );

    it('counts a rejection for a wrong key', () => {
      const port = createPort();
      const guard = createGuard(port, 'secret-key');

      expect(() =>
        guard.canActivate(createContext({ 'x-internal-api-key': 'wrong' })),
      ).toThrow(UnauthorizedException);
      expect(port.incRejected).toHaveBeenCalledTimes(1);
    });

    it('counts a rejection for a missing key', () => {
      const port = createPort();
      const guard = createGuard(port, 'secret-key');

      expect(() => guard.canActivate(createContext({}))).toThrow(
        UnauthorizedException,
      );
      expect(port.incRejected).toHaveBeenCalledTimes(1);
    });

    it('does not count successful requests', () => {
      const port = createPort();
      const guard = createGuard(port, 'secret-key');

      guard.canActivate(createContext({ 'x-internal-api-key': 'secret-key' }));
      expect(port.incRejected).not.toHaveBeenCalled();
    });

    it('does not count the missing-INTERNAL_API_KEY config error', () => {
      const port = createPort();
      const guard = createGuard(port, undefined);

      expect(() => guard.canActivate(createContext({}))).toThrow(
        InternalServerErrorException,
      );
      expect(port.incRejected).not.toHaveBeenCalled();
    });

    it('still rejects when no metrics port is provided', () => {
      const guard = createGuard(undefined, 'secret-key');

      expect(() =>
        guard.canActivate(createContext({ 'x-internal-api-key': 'wrong' })),
      ).toThrow(UnauthorizedException);
    });
  });
});
