import {
  isStrictProductionRuntime,
  isTestRuntime,
  readWispaceVerifyTokenUrl,
} from './production-runtime.utils';
import { ConfigService } from '@nestjs/config';

describe('production-runtime.utils', () => {
  const config = (env: Record<string, string | undefined>) =>
    ({
      get: (key: string) => env[key],
    }) as ConfigService;

  it('reads WISPACE_API_VERIFY_TOKEN_URL (shared across all 3 bots)', () => {
    expect(
      readWispaceVerifyTokenUrl(
        config({
          WISPACE_API_VERIFY_TOKEN_URL: 'https://example.com/verify-token-url',
        }),
      ),
    ).toBe('https://example.com/verify-token-url');
  });

  it('returns undefined when WISPACE_API_VERIFY_TOKEN_URL is unset', () => {
    expect(readWispaceVerifyTokenUrl(config({}))).toBeUndefined();
  });

  it('fails closed on an unsafe verify URL', () => {
    expect(() =>
      readWispaceVerifyTokenUrl(
        config({
          WISPACE_API_VERIFY_TOKEN_URL:
            'http://backend.example.com/api/verify-token',
        }),
      ),
    ).toThrow('must use HTTPS');

    expect(() =>
      readWispaceVerifyTokenUrl(
        config({
          WISPACE_API_VERIFY_TOKEN_URL: 'https://localhost/api/verify-token',
          NODE_ENV: 'production',
        }),
      ),
    ).toThrow('must not target localhost or a private network');

    expect(() =>
      readWispaceVerifyTokenUrl(
        config({
          WISPACE_API_VERIFY_TOKEN_URL:
            'https://other.example.com/api/verify-token',
          WISPACE_ALLOWED_HOSTS: 'backend.example.com',
        }),
      ),
    ).toThrow('is not in WISPACE_ALLOWED_HOSTS');
  });

  it('detects strict production via ENFORCE_PROD_CHAT_QUOTA', () => {
    expect(
      isStrictProductionRuntime(config({ ENFORCE_PROD_CHAT_QUOTA: 'true' })),
    ).toBe(true);
    expect(isTestRuntime(config({ NODE_ENV: 'test' }))).toBe(true);
  });
});
