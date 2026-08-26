/**
 * Minimal runtime shape validator for WISPACE API responses.
 *
 * Validates that a JSON value matches an expected structure at the client
 * boundary, before it reaches business logic. Catches provider contract
 * drift (HTTP 200 with changed/malformed shape) early.
 *
 * No external dependencies — uses plain typeof checks like the existing
 * normalizer pattern in user-calendar-record.normalizer.ts.
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

type ValidatorFn = (value: unknown) => boolean;

interface FieldSpec {
  /** Field name for error messages. */
  name: string;
  /** Validation function. */
  validate: ValidatorFn;
  /** Human-readable expected type for error messages. */
  expected: string;
  /** Whether the field is required (default: true). */
  required?: boolean;
}

/**
 * Validate that a JSON object matches an expected shape.
 * Returns the typed value if valid, throws ShapeValidationError if not.
 *
 * @example
 * const goals = validateShape(raw, [
 *   { name: 'targetScore', validate: v => typeof v === 'string', expected: 'string' },
 *   { name: 'examDate', validate: v => typeof v === 'string', expected: 'string' },
 * ]);
 */
export function validateShape<T>(value: unknown, fields: FieldSpec[]): T {
  if (value === null || value === undefined || typeof value !== 'object') {
    throw new ShapeValidationError(
      `Expected object, received ${typeof value}`,
      '(root)',
      'object',
      value,
    );
  }

  const obj = value as Record<string, unknown>;

  for (const field of fields) {
    const fieldValue = obj[field.name];

    if (
      field.required !== false &&
      (fieldValue === undefined || fieldValue === null)
    ) {
      throw new ShapeValidationError(
        `Missing required field "${field.name}"`,
        field.name,
        field.expected,
        fieldValue,
      );
    }

    if (
      fieldValue !== undefined &&
      fieldValue !== null &&
      !field.validate(fieldValue)
    ) {
      throw new ShapeValidationError(
        `Invalid field "${field.name}": expected ${field.expected}, received ${typeof fieldValue}`,
        field.name,
        field.expected,
        fieldValue,
      );
    }
  }

  return value as T;
}

/**
 * Validate that a value is a non-empty string.
 */
export function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Validate that a value is a positive number.
 */
export function isPositiveNumber(value: unknown): boolean {
  return typeof value === 'number' && value > 0 && Number.isFinite(value);
}

/**
 * Validate that a value is a non-negative number (>= 0).
 */
export function isNonNegativeNumber(value: unknown): boolean {
  return typeof value === 'number' && value >= 0 && Number.isFinite(value);
}

/**
 * Validate that a value is a valid ISO date string.
 */
export function isDateString(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return !Number.isNaN(time);
}

/**
 * Validate that a value is a valid HTTPS URL.
 */
export function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}
