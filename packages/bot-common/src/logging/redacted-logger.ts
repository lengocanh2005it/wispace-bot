import { LoggerService } from '@nestjs/common';

/** Long digit runs (PSID 15-17, Discord snowflake 17-19) → keep head/tail + length. */
const RAW_ID_PATTERN = /\d{15,}/g;

/**
 * Digit-run redaction for every log line (#610): platform external ids are
 * long decimal runs, so masking runs of ≥15 digits structurally covers PSID,
 * Discord snowflakes, and Zalo ids without knowing call sites. Epoch-ms
 * timestamps (13 digits), ports, counters, and job ids stay readable; hex
 * (uuid) is not a digit run. Already-masked values (`ps…45`) and
 * `[REDACTED]` placeholders from `errorMessage` pass through unchanged.
 * Free text is NOT rewritten here — learner-text hygiene stays a call-site
 * convention (AGENTS.md "Log redaction") — this layer only guarantees ids.
 */
export function redactLogLine(line: string): string {
  return line.replace(
    RAW_ID_PATTERN,
    (match) => `${match.slice(0, 2)}…${match.slice(-2)}(${match.length})`,
  );
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
    if (typeof message !== 'string') {
      this.sink(level, message);
      return;
    }
    const prefix = context ? `[${context}] ` : '';
    // Stacks can embed ids (URLs, query strings) — same redaction as the
    // message; call sites cannot be trusted to have sanitized them (#610).
    const line = `${prefix}${redactLogLine(message)}${
      stack ? `\n${redactLogLine(stack)}` : ''
    }`;
    this.sink(level, line);
  }
}
