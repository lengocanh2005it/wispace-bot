import { inspect } from 'node:util';
import { LoggerService } from '@nestjs/common';
import { redactRegisteredSecretValues } from '../masking';

/** Long digit runs (PSID 15-17, Discord snowflake 17-19) → keep head/tail + length. */
const RAW_ID_PATTERN = /\d{15,}/g;

/** Depth cap keeps an accidentally huge payload from becoming a log flood. */
const INSPECT_DEPTH = 2;

/**
 * The last line of defence for every log line, including object payloads and
 * stack arguments, so a call site that forgot to mask cannot leak.
 *
 * Two passes, in this order:
 *  1. **Registered runtime secret values** (`#632`), exact-value replacement.
 *     Must run first: an all-digit secret would otherwise be mangled by the
 *     digit-run pass below and no longer match by value.
 *  2. **Digit runs** — platform external ids are long decimal runs, so masking
 *     runs of >=15 digits structurally covers PSID, Discord snowflakes, and Zalo
 *     ids without knowing call sites. Epoch-ms timestamps (13 digits), ports,
 *     counters, and job ids stay readable; hex (uuid) is not a digit run.
 *     Already-masked values (`ps...45`) and `[REDACTED]` placeholders pass
 *     through unchanged.
 *
 * Free text is NOT rewritten here beyond those two — learner-text hygiene
 * stays a call-site convention (AGENTS.md "Log redaction").
 */
export function redactLogLine(line: string): string {
  return redactRegisteredSecretValues(line).text.replace(
    RAW_ID_PATTERN,
    (match) => `${match.slice(0, 2)}…${match.slice(-2)}(${match.length})`,
  );
}

/**
 * Render a non-string log payload as text so it goes through the same redaction
 * as a string message. Forwarding the object untouched let `console` inspect it
 * with nothing masked. `inspect` is circular-safe and handles Errors with their
 * stack, which `String()` would throw away.
 */
function serializeForLog(value: unknown): string {
  try {
    return inspect(value, { depth: INSPECT_DEPTH });
  } catch {
    return '[unserializable log payload]';
  }
}

export interface RedactedLoggerOptions {
  /** Test seam — defaults to console writes. */
  write?: (level: string, line: unknown) => void;
}

const CONSOLE_METHOD: Record<string, 'log' | 'warn' | 'error'> = {
  log: 'log',
  debug: 'log',
  verbose: 'log',
  warn: 'warn',
  error: 'error',
  fatal: 'error',
};

/**
 * Global logger adapter (#610): set via `app.useLogger(new RedactedLogger())`
 * so every Nest `Logger` call in every service — current and future — passes
 * through `redactLogLine` before it reaches the transport. Diagnostic value
 * is preserved: masked ids keep length + head/tail, error stacks pass
 * through, non-string messages are forwarded untouched for the transport to
 * inspect.
 */
export class RedactedLogger implements LoggerService {
  private readonly sink: (level: string, line: unknown) => void;

  constructor(options: RedactedLoggerOptions = {}) {
    this.sink =
      options.write ??
      ((level, line) => {
        // eslint-disable-next-line no-console -- default transport
        console[CONSOLE_METHOD[level] ?? 'log'](line);
      });
  }

  log(message: unknown, stack?: string, context?: string): void {
    this.emit('log', message, stack, context);
  }

  warn(message: unknown, stack?: string, context?: string): void {
    this.emit('warn', message, stack, context);
  }

  error(message: unknown, stack?: string, context?: string): void {
    this.emit('error', message, stack, context);
  }

  debug(message: unknown, stack?: string, context?: string): void {
    this.emit('debug', message, stack, context);
  }

  verbose(message: unknown, stack?: string, context?: string): void {
    this.emit('verbose', message, stack, context);
  }

  fatal(message: unknown, stack?: string, context?: string): void {
    this.emit('fatal', message, stack, context);
  }

  private emit(
    level: string,
    message: unknown,
    stack?: string,
    context?: string,
  ): void {
    const prefix = context ? `[${context}] ` : '';
    // Stacks can embed ids, URLs, query strings and config — same redaction as
    // the message; call sites cannot be trusted to have sanitized them (#610).
    const line = `${prefix}${redactLogLine(
      typeof message === 'string' ? message : serializeForLog(message),
    )}${stack ? `\n${redactLogLine(stack)}` : ''}`;
    this.sink(level, line);
  }
}

/**
 * Console-backed sink for the shared components that take a `{ warn, error }`
 * port instead of Nest's `LoggerService`. Passing a bare `console.*` there
 * bypassed redaction entirely, so those lines were the one place with neither
 * id masking nor secret redaction. The transport is still the console; only the
 * redaction differs from a hand-rolled `console.warn(message)`.
 */
export const consoleRedactedLogger = new RedactedLogger();
