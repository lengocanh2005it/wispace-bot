import { z } from 'zod';

/**
 * Runtime shape validation for WISPACE API responses (ADR 0010).
 *
 * Each client carries one zod schema per response; validation is fail-closed
 * on missing/extra-typed fields and tolerant of extra fields (additive
 * upstream changes must not break the bot). Catches contract drift (HTTP 200
 * with changed/malformed shape) before it reaches business logic.
 *
 * ShapeValidationError is kept as the thrown type so app-side retry/terminal
 * classification is unchanged from the pre-zod implementation.
 */

export class ShapeValidationError extends Error {
  constructor(
    message: string,
    public readonly field: string,
    public readonly expected: string,
    public readonly received: unknown,
  ) {
    super(message);
    this.name = 'ShapeValidationError';
  }
}

export function validateShape<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }

  const issue = result.error.issues[0];
  if (!issue) {
    throw new ShapeValidationError(
      'Invalid WISPACE response shape',
      '(root)',
      'valid object',
      value,
    );
  }

  const field =
    issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
  const received = readPath(value, issue.path);
  const expected = 'expected' in issue ? String(issue.expected) : 'valid value';

  if (issue.path.length === 0) {
    throw new ShapeValidationError(
      `Expected ${expected}, received ${describe(received)}`,
      field,
      expected,
      received,
    );
  }

  if (issue.code === 'invalid_type' && isMissing(received)) {
    throw new ShapeValidationError(
      `Missing required field "${field}"`,
      field,
      expected,
      received,
    );
  }

  throw new ShapeValidationError(
    `Invalid field "${field}": ${issue.message}`,
    field,
    expected,
    received,
  );
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null;
}

function readPath(value: unknown, path: (string | number | symbol)[]): unknown {
  let current = value;
  for (const segment of path) {
    if (current === undefined || current === null) return current;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string | number | symbol, unknown>)[segment];
  }
  return current;
}

function describe(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
