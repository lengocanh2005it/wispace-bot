import { isPrivateNetworkHost } from './network-utils';

describe('isPrivateNetworkHost', () => {
  describe('IPv4 loopback', () => {
    it.each(['127.0.0.1', '127.0.0.0', '127.255.255.255', '127.1.2.3'])(
      'rejects %s',
      (host) => {
        expect(isPrivateNetworkHost(host)).toBe(true);
      },
    );
  });

  describe('IPv4 RFC1918 private ranges', () => {
    it.each([
      '10.0.0.1',
      '10.255.255.255',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '192.168.255.255',
    ])('rejects %s', (host) => {
      expect(isPrivateNetworkHost(host)).toBe(true);
    });
  });

  describe('IPv4 link-local (169.254.0.0/16)', () => {
    it.each(['169.254.0.1', '169.254.255.255', '169.254.1.100'])(
      'rejects %s',
      (host) => {
        expect(isPrivateNetworkHost(host)).toBe(true);
      },
    );
  });

  describe('IPv4 public addresses', () => {
    it.each(['8.8.8.8', '1.1.1.1', '203.0.113.1', '198.51.100.1'])(
      'allows %s',
      (host) => {
        expect(isPrivateNetworkHost(host)).toBe(false);
      },
    );
  });

  describe('localhost variants', () => {
    it.each(['localhost', '127.0.0.1', '::1', '::'])('rejects %s', (host) => {
      expect(isPrivateNetworkHost(host)).toBe(true);
    });
  });

  describe('IPv6 loopback', () => {
    it('rejects ::1', () => {
      expect(isPrivateNetworkHost('::1')).toBe(true);
    });

    it('rejects [::1] (bracket notation)', () => {
      expect(isPrivateNetworkHost('[::1]')).toBe(true);
    });
  });

  describe('IPv6 unspecified address', () => {
    it('rejects ::', () => {
      expect(isPrivateNetworkHost('::')).toBe(true);
    });

    it('rejects 0000:0000:0000:0000:0000:0000:0000:0000', () => {
      expect(
        isPrivateNetworkHost('0000:0000:0000:0000:0000:0000:0000:0000'),
      ).toBe(true);
    });
  });

  describe('IPv6 link-local (fe80::/10)', () => {
    it.each(['fe80::1', 'fe80::abcd:1234', 'fe80::'])('rejects %s', (host) => {
      expect(isPrivateNetworkHost(host)).toBe(true);
    });

    it('rejects [fe80::1] (bracket notation)', () => {
      expect(isPrivateNetworkHost('[fe80::1]')).toBe(true);
    });
  });

  describe('IPv6 unique local address (fc00::/7)', () => {
    it.each(['fc00::1', 'fd00::1', 'fc00::abcd:1234', 'fd00::abcd:1234'])(
      'rejects %s',
      (host) => {
        expect(isPrivateNetworkHost(host)).toBe(true);
      },
    );
  });

  describe('IPv6 global unicast', () => {
    it.each(['2001:db8::1', '2607:f8b0:4004:800::200e'])(
      'allows %s',
      (host) => {
        expect(isPrivateNetworkHost(host)).toBe(false);
      },
    );
  });

  describe('IPv4-mapped IPv6', () => {
    it('rejects ::ffff:127.0.0.1 (loopback)', () => {
      expect(isPrivateNetworkHost('::ffff:127.0.0.1')).toBe(true);
    });

    it('rejects ::ffff:10.0.0.1 (RFC1918)', () => {
      expect(isPrivateNetworkHost('::ffff:10.0.0.1')).toBe(true);
    });

    it('rejects ::ffff:192.168.1.1 (RFC1918)', () => {
      expect(isPrivateNetworkHost('::ffff:192.168.1.1')).toBe(true);
    });

    it('allows ::ffff:8.8.8.8 (public)', () => {
      expect(isPrivateNetworkHost('::ffff:8.8.8.8')).toBe(false);
    });
  });

  describe('case insensitivity', () => {
    it('handles uppercase IPv4-mapped', () => {
      expect(isPrivateNetworkHost('::FFFF:10.0.0.1')).toBe(true);
    });

    it('handles uppercase IPv6', () => {
      expect(isPrivateNetworkHost('FE80::1')).toBe(true);
    });

    it('handles mixed case localhost', () => {
      expect(isPrivateNetworkHost('LocalHost')).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it.each(['not-an-ip', '999.999.999.999', '12345::1'])(
      'allows invalid input %s (returns false)',
      (host) => {
        expect(isPrivateNetworkHost(host)).toBe(false);
      },
    );
  });
});
