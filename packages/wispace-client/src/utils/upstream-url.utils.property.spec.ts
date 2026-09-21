import fc from 'fast-check';
import { validateUpstreamUrl } from './upstream-url.utils';

fc.configureGlobal({ numRuns: 200 });

const PUBLIC_HOST = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), {
    minLength: 3,
    maxLength: 16,
  })
  .map((chars) => `${chars.join('')}.example.test`);

describe('upstream URL policy properties', () => {
  it('accepts public HTTPS URLs on a case-insensitive exact allowlist', () => {
    fc.assert(
      fc.property(PUBLIC_HOST, (host) => {
        const value = `https://${host}/api`;
        expect(
          validateUpstreamUrl(value, {
            context: 'TEST_URL',
            nodeEnv: 'production',
            allowedHosts: [host.toUpperCase()],
          }),
        ).toBe(value);
      }),
    );
  });

  it('rejects a public HTTPS URL outside an exact allowlist', () => {
    fc.assert(
      fc.property(PUBLIC_HOST, (host) => {
        expect(() =>
          validateUpstreamUrl(`https://${host}.other.example/api`, {
            context: 'TEST_URL',
            nodeEnv: 'production',
            allowedHosts: [host],
          }),
        ).toThrow('not in');
      }),
    );
  });

  it('rejects credentials and fragments for every generated public host', () => {
    fc.assert(
      fc.property(PUBLIC_HOST, (host) => {
        expect(() =>
          validateUpstreamUrl(`https://user:pass@${host}/api`, {
            context: 'TEST_URL',
          }),
        ).toThrow('credentials');
        expect(() =>
          validateUpstreamUrl(`https://${host}/api#fragment`, {
            context: 'TEST_URL',
          }),
        ).toThrow('fragment');
      }),
    );
  });

  it('rejects non-HTTPS public URLs outside development loopback', () => {
    fc.assert(
      fc.property(PUBLIC_HOST, (host) => {
        expect(() =>
          validateUpstreamUrl(`http://${host}/api`, {
            context: 'TEST_URL',
            nodeEnv: 'production',
          }),
        ).toThrow('HTTPS');
      }),
    );
  });

  it('rejects private and loopback targets in production', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'localhost',
          '127.0.0.1',
          '10.0.0.1',
          '192.168.1.10',
          '169.254.169.254',
          '[fd00::1]',
        ),
        (host) => {
          expect(() =>
            validateUpstreamUrl(`https://${host}/api`, {
              context: 'TEST_URL',
              nodeEnv: 'production',
            }),
          ).toThrow('private network');
        },
      ),
    );
  });

  it('requires a non-empty allowlist when the policy requires one', () => {
    fc.assert(
      fc.property(PUBLIC_HOST, (host) => {
        expect(() =>
          validateUpstreamUrl(`https://${host}/api`, {
            context: 'TEST_URL',
            requireAllowedHosts: true,
          }),
        ).toThrow('allowlist');
      }),
    );
  });
});
