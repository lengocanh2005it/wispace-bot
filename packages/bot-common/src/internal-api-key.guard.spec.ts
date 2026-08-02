import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
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
});
