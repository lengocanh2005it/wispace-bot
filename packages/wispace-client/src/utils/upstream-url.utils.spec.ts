import { validateUpstreamUrl } from './upstream-url.utils';

const CONTEXT = 'WISPACE_API_TEST_URL';

describe('validateUpstreamUrl', () => {
  it('rejects a missing required allowlist', () => {
    expect(() =>
      validateUpstreamUrl('https://api.example.com/v1', {
        context: 'TEST_URL',
        nodeEnv: 'production',
        allowedHosts: [],
        requireAllowedHosts: true,
      }),
    ).toThrow(/TEST_URL requires a non-empty host allowlist/i);
  });

  it('rejects a bare fragment delimiter', () => {
    expect(() =>
      validateUpstreamUrl('https://api.example.com/v1#', {
        context: CONTEXT,
        nodeEnv: 'production',
        allowedHosts: ['api.example.com'],
      }),
    ).toThrow(/must not contain a fragment/i);
  });

  it('accepts a valid HTTPS URL', () => {
    expect(
      validateUpstreamUrl('https://backend.example.com/api/User/goals', {
        context: CONTEXT,
      }),
    ).toBe('https://backend.example.com/api/User/goals');
  });

  it.each(['not-a-url', 'ftp://example.com/x', '//example.com/x', ''])(
    'rejects an unparseable or non-HTTP(S) value: %s',
    (value) => {
      expect(() => validateUpstreamUrl(value, { context: CONTEXT })).toThrow(
        CONTEXT,
      );
    },
  );

  it('rejects HTTP outside the development/test loopback exception', () => {
    expect(() =>
      validateUpstreamUrl('http://backend.example.com/x', {
        context: CONTEXT,
      }),
    ).toThrow('must use HTTPS');

    expect(() =>
      validateUpstreamUrl('http://backend.example.com/x', {
        context: CONTEXT,
        nodeEnv: 'production',
      }),
    ).toThrow('must use HTTPS');
  });

  it('allows http://localhost only in an explicit development/test env', () => {
    expect(
      validateUpstreamUrl('http://localhost:8080/wispace', {
        context: CONTEXT,
        nodeEnv: 'development',
      }),
    ).toBe('http://localhost:8080/wispace');

    expect(
      validateUpstreamUrl('http://127.0.0.1:8080/wispace', {
        context: CONTEXT,
        nodeEnv: 'test',
      }),
    ).toBe('http://127.0.0.1:8080/wispace');

    expect(() =>
      validateUpstreamUrl('http://localhost:8080/wispace', {
        context: CONTEXT,
        nodeEnv: 'production',
      }),
    ).toThrow('must use HTTPS');
  });

  it('rejects URLs with embedded credentials', () => {
    expect(() =>
      validateUpstreamUrl('https://user:pass@backend.example.com/x', {
        context: CONTEXT,
      }),
    ).toThrow('must not contain credentials');
  });

  it('rejects URLs with a fragment', () => {
    expect(() =>
      validateUpstreamUrl('https://backend.example.com/x#section', {
        context: CONTEXT,
      }),
    ).toThrow('must not contain a fragment');
  });

  it.each([undefined, 'production'])(
    'rejects loopback/private targets outside development: NODE_ENV=%s',
    (nodeEnv) => {
      const env = nodeEnv ? { nodeEnv } : {};
      expect(() =>
        validateUpstreamUrl('https://localhost/api', {
          context: CONTEXT,
          ...env,
        }),
      ).toThrow('must not target localhost or a private network');
      expect(() =>
        validateUpstreamUrl('https://192.168.1.10/api', {
          context: CONTEXT,
          ...env,
        }),
      ).toThrow('must not target localhost or a private network');
    },
  );

  it('allows private targets in development', () => {
    expect(
      validateUpstreamUrl('https://192.168.1.10/api', {
        context: CONTEXT,
        nodeEnv: 'development',
      }),
    ).toBe('https://192.168.1.10/api');
  });

  it.each([undefined, 'production'])(
    'rejects link-local targets in production: NODE_ENV=%s',
    (nodeEnv) => {
      const env = nodeEnv ? { nodeEnv } : {};
      expect(() =>
        validateUpstreamUrl('https://169.254.169.254/api', {
          context: CONTEXT,
          ...env,
        }),
      ).toThrow('must not target localhost or a private network');
    },
  );

  it.each([undefined, 'production'])(
    'rejects IPv6 private targets in production: NODE_ENV=%s',
    (nodeEnv) => {
      const env = nodeEnv ? { nodeEnv } : {};
      expect(() =>
        validateUpstreamUrl('https://[fd00::1]/api', {
          context: CONTEXT,
          ...env,
        }),
      ).toThrow('must not target localhost or a private network');
      expect(() =>
        validateUpstreamUrl('https://[fe80::1]/api', {
          context: CONTEXT,
          ...env,
        }),
      ).toThrow('must not target localhost or a private network');
    },
  );

  // #963 — IPv4-compatible / IPv4-mapped IPv6 targets embed a real IPv4
  // destination and must be classified as that destination.
  it.each([undefined, 'production'])(
    'rejects IPv4-compatible and IPv4-mapped IPv6 targets in production: NODE_ENV=%s',
    (nodeEnv) => {
      const env = nodeEnv ? { nodeEnv } : {};
      const privateTargets = [
        'https://[::ffff:10.0.0.1]/api', // IPv4-mapped RFC1918
        'https://[::10.0.0.1]/api', // IPv4-compatible dotted, RFC1918
        'https://[::127.0.0.1]/api', // IPv4-compatible dotted, loopback
        'https://[::a00:1]/api', // hex shorthand of ::10.0.0.1
        'https://[::ffff:169.254.169.254]/api', // mapped cloud metadata
        'https://[::ffff:a9fe:a9fe]/api', // mapped cloud metadata, hex
        'https://[::169.254.169.254]/api', // compatible cloud metadata
        'https://[0:0:0:0:0:ffff:10.0.0.1]/api', // fully expanded mapped
      ];
      for (const target of privateTargets) {
        expect(() =>
          validateUpstreamUrl(target, { context: CONTEXT, ...env }),
        ).toThrow('must not target localhost or a private network');
      }
    },
  );

  it('rejects URL-parser-canonicalized IPv4 hosts (#963)', () => {
    // WHATWG URL canonicalizes decimal integer hosts to dotted IPv4 —
    // 2130706433 is 127.0.0.1 and must be rejected like the plain form.
    const parsed = new URL('https://2130706433/api');
    expect(parsed.hostname).toBe('127.0.0.1');
    expect(() =>
      validateUpstreamUrl('https://2130706433/api', { context: CONTEXT }),
    ).toThrow('must not target localhost or a private network');
  });

  it('still accepts public IPv4-mapped IPv6 targets in production', () => {
    expect(
      validateUpstreamUrl('https://[::ffff:8.8.8.8]/api', {
        context: CONTEXT,
      }),
    ).toBe('https://[::ffff:8.8.8.8]/api');
  });

  it('allowlist cannot rescue a private target — the private check runs first', () => {
    expect(() =>
      validateUpstreamUrl('https://[::ffff:10.0.0.1]/api', {
        context: CONTEXT,
        allowedHosts: ['::ffff:10.0.0.1'],
      }),
    ).toThrow('must not target localhost or a private network');
  });

  it('allows public hosts in the allowlist, exact match (#963 unchanged)', () => {
    expect(
      validateUpstreamUrl('https://backend.aihubproduction.com/api', {
        context: CONTEXT,
        allowedHosts: ['backend.aihubproduction.com'],
      }),
    ).toBe('https://backend.aihubproduction.com/api');
  });

  it('allows link-local targets in development', () => {
    expect(
      validateUpstreamUrl('https://169.254.169.254/api', {
        context: CONTEXT,
        nodeEnv: 'development',
      }),
    ).toBe('https://169.254.169.254/api');
  });

  it('rejects a host not in the allowlist', () => {
    expect(() =>
      validateUpstreamUrl('https://other.example.com/x', {
        context: CONTEXT,
        allowedHosts: ['backend.example.com'],
      }),
    ).toThrow('is not in WISPACE_ALLOWED_HOSTS');
  });

  it('accepts a host in the allowlist (case-insensitive)', () => {
    expect(
      validateUpstreamUrl('https://Backend.Example.com/x', {
        context: CONTEXT,
        allowedHosts: ['backend.example.com'],
      }),
    ).toBe('https://Backend.Example.com/x');
  });

  it('does not enforce the allowlist when it is empty', () => {
    expect(
      validateUpstreamUrl('https://backend.example.com/x', {
        context: CONTEXT,
        allowedHosts: [],
      }),
    ).toBe('https://backend.example.com/x');
  });
});
