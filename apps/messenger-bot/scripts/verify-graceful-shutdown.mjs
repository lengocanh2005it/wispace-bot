/**
 * Scripted verification for #511: SIGTERM during a fake in-flight request
 * must still let the request complete within the drain window before exit,
 * with tracing flushed after the drain (not racing it).
 *
 * Modes:
 * - default: parent spawns a child harness, sends a real SIGTERM mid-request
 *   and asserts HTTP 200 + tracing flush + exit 0. Needs real signal
 *   delivery, so on Windows it falls back to --selftest (see below).
 * - --child: harness process (plain http server + the real
 *   createShutdownHandler/shutdownTracing wiring from ../dist).
 * - --selftest: single-process check that runs anywhere — asserts
 *   tracing.ts registers no signal listeners of its own, then drives the
 *   real shutdown handler through a live in-flight request.
 *
 * Prerequisite: `npm run build` (requires ../dist/tracing.js and
 * ../dist/graceful-shutdown.js).
 *
 * Exit 0 = PASS. Anything else prints the failure and exits non-zero.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const SLOW_MS = 4_000;
const PARENT_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message, child) {
  console.error(`verify-graceful-shutdown: FAIL — ${message}`);
  if (child && child.exitCode === null) child.kill('SIGKILL');
  process.exit(1);
}

async function bootHarness({
  logger = console,
  exit,
  timeoutMs = 45_000,
  tracingLogger,
}) {
  const { createShutdownHandler } =
    await import('../dist/shared/common/graceful-shutdown.js');
  const { shutdownTracing } = await import('../dist/shared/common/tracing.js');

  const server = http.createServer((req, res) => {
    if (req.url === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { Connection: 'close' });
        res.end('done');
      }, SLOW_MS);
    } else {
      res.writeHead(404, { Connection: 'close' });
      res.end();
    }
  });
  const app = {
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
  const shutdown = createShutdownHandler({
    app,
    // Optional logger override routes the flush result into the harness
    // log capture; production passes shutdownTracing bare.
    shutdownTracing: tracingLogger
      ? () => shutdownTracing({ logger: tracingLogger })
      : shutdownTracing,
    timeoutMs,
    logger,
    exit,
  });
  await new Promise((resolve) => server.listen(0, resolve));
  return { shutdown, port: server.address().port };
}

function getSlow(port) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}/slow`, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

async function runChild() {
  await import('../dist/shared/common/tracing.js'); // side effect: sdk.start(); no signal handlers (#511)
  const { shutdown, port } = await bootHarness({
    logger: console,
    exit: (code) => process.exit(code),
  });
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  console.log(`READY ${port}`);
}

async function runSelftest() {
  // 1. tracing.ts must not register signal listeners of its own (#511).
  const termBefore = process.listenerCount('SIGTERM');
  const intBefore = process.listenerCount('SIGINT');
  await import('../dist/shared/common/tracing.js');
  const termAfter = process.listenerCount('SIGTERM');
  const intAfter = process.listenerCount('SIGINT');
  if (termAfter !== termBefore || intAfter !== intBefore) {
    fail(
      `tracing.ts registered its own signal handlers (SIGTERM ${termBefore}→${termAfter}, SIGINT ${intBefore}→${intAfter})`,
    );
  }

  // 2. Drive the real shutdown handler through a live in-flight request.
  const lines = [];
  const logger = {
    log: (m) => lines.push(`log: ${m}`),
    error: (m) => lines.push(`error: ${m}`),
    warn: (m) => lines.push(`warn: ${m}`),
  };
  let exitCode = null;
  const { shutdown, port } = await bootHarness({
    logger,
    tracingLogger: logger,
    exit: (code) => (exitCode = code),
  });

  const responsePromise = getSlow(port);
  await sleep(500);
  shutdown('SIGTERM'); // direct call: signal delivery itself is platform behavior
  const response = await responsePromise;
  if (response.status !== 200 || response.body !== 'done') {
    fail(
      `in-flight request did not drain: ${response.status} ${response.body}`,
    );
  }
  if (exitCode !== 0) {
    fail(`expected exit 0, recorded ${exitCode}`);
  }
  if (!lines.some((l) => l.includes('Tracing shutdown completed'))) {
    fail(`tracing flush did not run after drain\n${lines.join('\n')}`);
  }
  if (!lines.some((l) => l.includes('OTel SDK shutdown completed'))) {
    fail(`tracing flush did not succeed\n${lines.join('\n')}`);
  }
  console.log(
    'verify-graceful-shutdown: PASS (selftest) — no tracing listeners, in-flight drained (200), tracing flushed, exit 0',
  );
}

async function runParent() {
  if (process.platform === 'win32') {
    console.log(
      'verify-graceful-shutdown: Windows cannot deliver graceful SIGTERM, running selftest instead',
    );
    await runSelftest();
    return;
  }
  const self = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [self, '--child'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));

  const overall = setTimeout(
    () => fail(`timed out after ${PARENT_TIMEOUT_MS}ms\n${output}`, child),
    PARENT_TIMEOUT_MS,
  );

  await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      if (chunk.toString().includes('READY')) {
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.on('exit', (code) =>
      reject(new Error(`child exited early with code ${code}\n${output}`)),
    );
  }).catch((err) => {
    clearTimeout(overall);
    fail(err.message, child);
  });
  const port = Number(/READY (\d+)/.exec(output)?.[1]);
  if (!port) {
    clearTimeout(overall);
    fail(`child did not report a port\n${output}`, child);
  }

  // Start a slow request, wait until it is in-flight, then SIGTERM.
  const responsePromise = getSlow(port);
  await sleep(500);
  child.kill('SIGTERM');

  const response = await responsePromise.catch((err) => {
    clearTimeout(overall);
    fail(
      `in-flight request did not complete (drain broken): ${err.message}\n${output}`,
      child,
    );
  });
  if (response.status !== 200 || response.body !== 'done') {
    clearTimeout(overall);
    fail(
      `unexpected response: ${response.status} ${response.body}\n${output}`,
      child,
    );
  }

  const exitCode = await new Promise((resolve) => child.on('exit', resolve));
  clearTimeout(overall);
  if (exitCode !== 0) {
    fail(`child exited with code ${exitCode}, expected 0\n${output}`, child);
  }
  if (!output.includes('Tracing shutdown completed')) {
    fail(`tracing flush did not run after drain\n${output}`, child);
  }
  if (!output.includes('OTel SDK shutdown completed')) {
    fail(`tracing flush did not succeed\n${output}`, child);
  }
  console.log(
    'verify-graceful-shutdown: PASS — in-flight request drained (200), tracing flushed, exit 0',
  );
}

if (process.argv.includes('--child')) {
  await runChild();
} else if (process.argv.includes('--selftest')) {
  await runSelftest();
} else {
  await runParent();
}
