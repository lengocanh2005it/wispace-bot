import { errorMessage, sanitizeErrorStack } from '@wispace/bot-common/masking';

export type ShutdownSignal = 'SIGTERM' | 'SIGINT';

export interface ShutdownLogger {
  log(message: string): void;
  error(message: string, ...args: unknown[]): void;
  warn(message: string): void;
}

export interface ShutdownDeps {
  app: { close: () => Promise<void> };
  shutdownTracing: () => Promise<void>;
  timeoutMs: number;
  logger: ShutdownLogger;
  exit: (code: number) => void;
}

function formatError(err: unknown): [string, unknown?] {
  return [
    `Error during graceful shutdown: ${errorMessage(err)}`,
    err instanceof Error ? sanitizeErrorStack(err.stack) : undefined,
  ];
}

/**
 * Single-owner graceful shutdown (#511). The returned handler owns process
 * exit ordering: drain the app first, then flush tracing, then exit 0 — with
 * a force-exit(1) backstop if the drain exceeds `timeoutMs`. The tracing
 * flush is attempted even when the drain throws, so captured spans are not
 * silently dropped. A second signal while shutting down is ignored so
 * `app.close()` never runs twice, and `exit` is called exactly once.
 */
export function createShutdownHandler(deps: ShutdownDeps) {
  const { app, shutdownTracing, timeoutMs, logger, exit } = deps;
  let shuttingDown = false;
  let exited = false;

  return (signal: ShutdownSignal): void => {
    if (shuttingDown) {
      logger.log(`Already shutting down, ignoring ${signal}`);
      return;
    }
    shuttingDown = true;

    void (async () => {
      logger.log(`Received ${signal}, starting graceful shutdown…`);

      const forceExitTimeout = setTimeout(() => {
        logger.error(
          `Graceful shutdown timed out after ${timeoutMs}ms, forcing exit`,
        );
        exited = true;
        exit(1);
      }, timeoutMs);
      forceExitTimeout.unref();

      try {
        await app.close();
        logger.log('Graceful shutdown completed');
      } catch (err) {
        logger.error(...formatError(err));
      }
      try {
        await shutdownTracing();
        logger.log('Tracing shutdown completed');
      } catch (err) {
        logger.error(...formatError(err));
      } finally {
        if (!exited) {
          clearTimeout(forceExitTimeout);
          exit(0);
        }
      }
    })();
  };
}
