import http from 'node:http';
import type { Socket } from 'node:net';
import {
  closeKeepAliveAgents,
  getKeepAliveAgent,
  keepAliveFetch,
} from './keep-alive-agent';

const realFetch = globalThis.fetch;

function mockFetch() {
  const calls: Array<{ url: unknown; init: Record<string, unknown> }> = [];
  globalThis.fetch = jest
    .fn()
    .mockImplementation((url: unknown, init: unknown) => {
      calls.push({ url, init: (init ?? {}) as Record<string, unknown> });
      return Promise.resolve(new Response('{}'));
    });
  return calls;
}

describe('keep-alive agent (#567)', () => {
  beforeEach(() => {
    mockFetch();
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await closeKeepAliveAgents();
  });

  it('returns the same agent for the same host', () => {
    expect(getKeepAliveAgent('https://api.wispace.test/a')).toBe(
      getKeepAliveAgent('https://api.wispace.test/b/c'),
    );
  });

  it('returns distinct agents per host', () => {
    expect(getKeepAliveAgent('https://api.wispace.test/x')).not.toBe(
      getKeepAliveAgent('https://other.wispace.test/x'),
    );
  });

  it('attaches the host agent as dispatcher without touching the signal', async () => {
    const controller = new AbortController();
    await keepAliveFetch(
      'https://api.wispace.test/goals',
      { headers: { 'x-test': '1' }, signal: controller.signal },
      { poolSize: 6 },
    );

    const fetchMock = globalThis.fetch as jest.Mock;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as Record<string, unknown>;
    expect(init.dispatcher).toBe(
      getKeepAliveAgent('https://api.wispace.test/goals'),
    );
    expect(init.signal).toBe(controller.signal);
    expect(init.headers).toEqual({ 'x-test': '1' });
  });

  it('logs once per host on first creation', async () => {
    const logger = { log: jest.fn() };
    await keepAliveFetch('https://api.wispace.test/a', {}, { logger });
    await keepAliveFetch('https://api.wispace.test/a', {}, { logger });

    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.log.mock.calls[0][0]).toContain('api.wispace.test');
  });

  it('reuses one TCP connection for sequential requests (localhost)', async () => {
    globalThis.fetch = realFetch;
    let connections = 0;
    const sockets = new Set<Socket>();
    const server = http.createServer((_req, res) => {
      res.end('{}');
    });
    server.on('connection', (socket) => {
      connections += 1;
      sockets.add(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    try {
      // Small gap between turns, like real chat traffic — back-to-back
      // dispatches can outrun undici's idle-socket bookkeeping.
      const sleep = (ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms));
      for (let i = 0; i < 5; i++) {
        const res = await keepAliveFetch(`http://127.0.0.1:${port}/goals`);
        await res.text();
        await sleep(50);
      }
      expect(connections).toBe(1);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('caps concurrent connections at poolSize (localhost)', async () => {
    globalThis.fetch = realFetch;
    let active = 0;
    let maxActive = 0;
    const sockets = new Set<Socket>();
    const server = http.createServer((_req, res) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => {
        active -= 1;
        res.end('{}');
      }, 30);
    });
    server.on('connection', (socket) => sockets.add(socket));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    try {
      await Promise.all(
        Array.from({ length: 5 }, async () => {
          const res = await keepAliveFetch(
            `http://127.0.0.1:${port}/goals`,
            {},
            { poolSize: 1 },
          );
          await res.text();
        }),
      );
      expect(maxActive).toBe(1);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
