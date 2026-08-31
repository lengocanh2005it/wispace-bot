import {
  isInjectionSanitizeReason,
  sanitizeToolResultContent,
} from './prompt-injection.utils';

export type ToolObservationOutcome =
  | 'kept'
  | 'truncated'
  | 'deduped'
  | 'dropped'
  | 'fallback';

/** First N chars of the pre-sanitization result, for injection-event triage (#629). */
const INJECTION_PREVIEW_CHARS = 200;

/**
 * A neutralized injection in a tool result (#629). `rawPreview` is
 * pre-sanitization and capped — the caller redacts it before persisting.
 */
export interface ToolObservationInjection {
  reason: string;
  rawPreview: string;
}

export interface ReducedToolObservation {
  content: string;
  canonical: string;
  outcome: Extract<ToolObservationOutcome, 'kept' | 'truncated' | 'fallback'>;
  wasTruncated: boolean;
  /** Present when `sanitizeToolResultContent` neutralized an injection pattern. */
  injection?: ToolObservationInjection;
}

const MAX_TOOL_OBSERVATION_CHARS = 8_000;
const TRUNCATED_SUFFIX = '... [truncated]';
// ponytail: fixed depth/key/item ceilings bound unknown tools; add a
// per-tool policy only when a real payload needs more detail.
const MAX_DEPTH = 5;
const MAX_KEYS = 32;
const MAX_ITEMS = 20;

const COMMON_ERROR_FIELDS = [
  'available',
  'blocked',
  'error',
  'message',
  'reason',
] as const;

const SESSION_FIELDS = [
  'calendarId',
  'sessionKey',
  'topic',
  'scheduledAtIso',
  'scheduledTimeLabel',
  'reminderNotice',
] as const;

const TOOL_FIELDS: Record<string, readonly string[]> = {
  get_user_goals: ['targetScore', 'examDate', ...COMMON_ERROR_FIELDS],
  get_learning_progress_report: ['report', ...COMMON_ERROR_FIELDS],
  get_upcoming_study_sessions: [
    'count',
    'sessions',
    'reminderNotice',
    ...COMMON_ERROR_FIELDS,
  ],
  list_study_calendar_entries: [
    'timeRange',
    'count',
    'entries',
    'reminderNotice',
    ...COMMON_ERROR_FIELDS,
  ],
  preview_next_study_reminder: [
    'hasSession',
    'scheduledTimeLabel',
    'reminder',
    'message',
    'session',
    ...COMMON_ERROR_FIELDS,
  ],
  reschedule_study_session: [
    'pendingConfirmation',
    'rescheduled',
    'sessionLabel',
    'summary',
    ...COMMON_ERROR_FIELDS,
  ],
  register_exam_report_notifications: [
    'registered',
    'alreadyActive',
    'automatic',
    'blocked',
    ...COMMON_ERROR_FIELDS,
  ],
  precreate_next_exercise: [
    'exerciseUrl',
    'url',
    'status',
    'created',
    'existing',
    'messageHint',
    ...COMMON_ERROR_FIELDS,
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= TRUNCATED_SUFFIX.length) {
    return value.slice(0, Math.max(0, maxChars));
  }
  const prefixLength = maxChars - TRUNCATED_SUFFIX.length;
  return `${value.slice(0, prefixLength)}${TRUNCATED_SUFFIX}`;
}

interface FieldSelection {
  value: Record<string, unknown>;
  omittedCount: number;
}

function pickFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): FieldSelection {
  const picked: Record<string, unknown> = {};
  let omittedCount = 0;
  const allowed = new Set(fields);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) omittedCount += 1;
  }
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      picked[field] = value[field];
    }
  }
  return { value: picked, omittedCount };
}

function pickSessionList(value: unknown): {
  value: unknown;
  omittedCount: number;
} {
  if (!Array.isArray(value)) return { value, omittedCount: 0 };
  let omittedCount = 0;
  const entries = value.map((entry) => {
    if (!isRecord(entry)) return entry;
    const selected = pickFields(entry, SESSION_FIELDS);
    omittedCount += selected.omittedCount;
    return selected.value;
  });
  return { value: entries, omittedCount };
}

interface ProjectedToolObservation {
  value: unknown;
  omittedCount: number;
}

function projectKnownToolObservation(
  toolName: string,
  result: unknown,
): ProjectedToolObservation {
  if (!isRecord(result)) return { value: result, omittedCount: 0 };
  const fields = TOOL_FIELDS[toolName];
  if (!fields) return { value: result, omittedCount: 0 };

  const selected = pickFields(result, fields);
  const projected = selected.value;
  let omittedCount = selected.omittedCount;
  if (Object.prototype.hasOwnProperty.call(projected, 'sessions')) {
    const sessions = pickSessionList(projected.sessions);
    projected.sessions = sessions.value;
    omittedCount += sessions.omittedCount;
  }
  if (Object.prototype.hasOwnProperty.call(projected, 'entries')) {
    const entries = pickSessionList(projected.entries);
    projected.entries = entries.value;
    omittedCount += entries.omittedCount;
  }
  if (Object.prototype.hasOwnProperty.call(projected, 'session')) {
    if (isRecord(projected.session)) {
      const session = pickFields(projected.session, SESSION_FIELDS);
      projected.session = session.value;
      omittedCount += session.omittedCount;
    }
  }

  if (omittedCount > 0) {
    // The allowlist is intentionally lossy. Keep that fact beside the data so
    // a model cannot mistake the projection for a complete tool response.
    projected._observation = 'truncated';
    projected.omittedCount = omittedCount;
  }
  return { value: projected, omittedCount };
}

/**
 * Keep only server-derived fields that the chat prompt needs. Unknown tools
 * retain their small payloads and are bounded by the generic walker below.
 */
export function projectToolObservation(
  toolName: string,
  result: unknown,
): unknown {
  return projectKnownToolObservation(toolName, result).value;
}

interface BoundedValue {
  value: unknown;
  truncated: boolean;
  omittedCount: number;
}

interface BoundOptions {
  depth: number;
  maxStringChars: number;
  maxKeys: number;
  maxItems: number;
}

function boundValue(
  value: unknown,
  options: BoundOptions,
  seen: WeakSet<object>,
): BoundedValue {
  if (typeof value === 'string') {
    return {
      value: truncateString(value, options.maxStringChars),
      truncated: value.length > options.maxStringChars,
      omittedCount: value.length > options.maxStringChars ? 1 : 0,
    };
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return {
      value:
        typeof value === 'number' && !Number.isFinite(value) ? null : value,
      truncated: false,
      omittedCount: 0,
    };
  }
  if (value === undefined) {
    return { value: null, truncated: true, omittedCount: 1 };
  }
  if (typeof value === 'bigint') {
    return { value: String(value), truncated: true, omittedCount: 1 };
  }
  if (typeof value !== 'object') {
    return { value: null, truncated: true, omittedCount: 1 };
  }

  if (seen.has(value)) {
    return {
      value: { _observation: 'unavailable' },
      truncated: true,
      omittedCount: 1,
    };
  }
  if (options.depth >= MAX_DEPTH) {
    return {
      value: { _observation: 'truncated' },
      truncated: true,
      omittedCount: 1,
    };
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const values: unknown[] = [];
      let truncated = false;
      let omittedCount = Math.max(0, value.length - options.maxItems);
      for (const item of value.slice(0, options.maxItems)) {
        const bounded = boundValue(
          item,
          { ...options, depth: options.depth + 1 },
          seen,
        );
        values.push(bounded.value);
        truncated ||= bounded.truncated;
        omittedCount += bounded.omittedCount;
      }
      truncated ||= value.length > options.maxItems;
      return { value: values, truncated, omittedCount };
    }

    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    let truncated = false;
    let omittedCount = 0;
    let keyCount = 0;
    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      if (keyCount >= options.maxKeys) {
        truncated = true;
        omittedCount += 1;
        continue;
      }
      keyCount += 1;
      let child: unknown;
      try {
        child = record[key];
      } catch {
        child = { _observation: 'unavailable' };
        truncated = true;
        omittedCount += 1;
      }
      const bounded = boundValue(
        child,
        { ...options, depth: options.depth + 1 },
        seen,
      );
      result[key] = bounded.value;
      truncated ||= bounded.truncated;
      omittedCount += bounded.omittedCount;
    }
    return { value: result, truncated, omittedCount };
  } finally {
    seen.delete(value);
  }
}

function serializeEnvelope(
  ok: boolean,
  data: unknown,
  error: string | undefined,
  options: BoundOptions,
): {
  content: string;
  truncated: boolean;
  omittedCount: number;
  injection?: ToolObservationInjection;
} | null {
  const bounded = ok
    ? boundValue(data, options, new WeakSet<object>())
    : boundValue(
        error ?? 'tool execution failed',
        options,
        new WeakSet<object>(),
      );
  const envelope: Record<string, unknown> = ok
    ? { ok: true, data: bounded.value }
    : { ok: false, error: bounded.value };
  if (bounded.truncated) {
    envelope._observation = 'truncated';
    envelope.omittedCount = Math.max(1, bounded.omittedCount);
  }

  try {
    const raw = JSON.stringify(envelope);
    if (!raw) return null;
    const sanitized = sanitizeToolResultContent(raw);
    const sanitizedChanged =
      sanitized.wasSanitized || sanitized.content.length < raw.length;
    const injection = isInjectionSanitizeReason(sanitized.reason)
      ? {
          reason: sanitized.reason as string,
          rawPreview: raw.slice(0, INJECTION_PREVIEW_CHARS),
        }
      : undefined;
    let content = sanitized.content;
    if (sanitizedChanged) {
      try {
        const parsed = JSON.parse(content) as unknown;
        if (isRecord(parsed)) {
          parsed._observation = 'truncated';
          const omittedCount =
            typeof parsed.omittedCount === 'number' &&
            Number.isFinite(parsed.omittedCount)
              ? parsed.omittedCount
              : 0;
          parsed.omittedCount = Math.max(1, omittedCount);
          content = JSON.stringify(parsed);
        } else {
          content = observationMarker('truncated', ok);
        }
      } catch {
        content = observationMarker('truncated', ok);
      }
    }
    return {
      content,
      truncated: bounded.truncated || sanitizedChanged,
      omittedCount: Math.max(bounded.omittedCount, sanitizedChanged ? 1 : 0),
      injection,
    };
  } catch {
    return null;
  }
}

function fallbackObservation(ok: boolean, error?: string): string {
  if (!ok && error) {
    return JSON.stringify({
      ok: false,
      error:
        error === 'observation_unavailable' ? error : 'observation_unavailable',
      _observation: 'fallback',
    });
  }
  return JSON.stringify({
    ok: true,
    _observation: 'truncated',
  });
}

export function observationMarker(
  marker: 'reused' | 'truncated' | 'fallback',
  ok = true,
): string {
  return ok
    ? JSON.stringify({ ok: true, _observation: marker })
    : JSON.stringify({
        ok: false,
        error: 'observation_unavailable',
        _observation: marker,
      });
}

function buildReducedObservation(
  content: string,
  outcome: ReducedToolObservation['outcome'],
  wasTruncated: boolean,
  injection?: ToolObservationInjection,
): ReducedToolObservation {
  let parsed: unknown = content;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    // Sanitized content is normally JSON; retaining a string is still safe.
  }
  return {
    content,
    canonical: canonicalizeToolObservation(parsed),
    outcome,
    wasTruncated,
    ...(injection ? { injection } : {}),
  };
}

/** Canonical JSON used only for same-round equality checks. */
export function canonicalizeToolObservation(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeToolObservation).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalizeToolObservation(value[key])}`,
      )
      .join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 'null' : serialized;
}

/**
 * Project, bound, sanitize, and serialize one tool result. The raw result is
 * never passed to the sanitizer, so an unexpectedly deep payload cannot make
 * the sanitizer recurse without limits.
 */
export function reduceToolObservation(input: {
  toolName: string;
  result?: unknown;
  error?: string;
  ok: boolean;
  maxChars: number;
}): ReducedToolObservation {
  let projected = input.result;
  let projectionWasTruncated = false;
  if (input.ok) {
    try {
      const projection = projectKnownToolObservation(
        input.toolName,
        input.result,
      );
      projected = projection.value;
      projectionWasTruncated = projection.omittedCount > 0;
    } catch {
      return buildReducedObservation(
        fallbackObservation(false, 'observation_unavailable'),
        'fallback',
        true,
      );
    }
  }

  return reduceBoundedObservation({
    projected,
    error: input.error,
    ok: input.ok,
    maxChars: input.maxChars,
    projectionWasTruncated,
  });
}

interface ReduceBoundedObservationInput {
  projected: unknown;
  error?: string;
  ok: boolean;
  maxChars: number;
  projectionWasTruncated?: boolean;
}

function reduceBoundedObservation(
  input: ReduceBoundedObservationInput,
): ReducedToolObservation {
  const maxChars = Math.max(
    1,
    Math.min(input.maxChars, MAX_TOOL_OBSERVATION_CHARS),
  );
  let outcome: ReducedToolObservation['outcome'] = 'kept';

  const attempts: BoundOptions[] = [
    { depth: 0, maxStringChars: 2_000, maxKeys: MAX_KEYS, maxItems: MAX_ITEMS },
    { depth: 0, maxStringChars: 1_000, maxKeys: 20, maxItems: 10 },
    { depth: 0, maxStringChars: 500, maxKeys: 12, maxItems: 5 },
    { depth: 0, maxStringChars: 200, maxKeys: 8, maxItems: 3 },
    { depth: 0, maxStringChars: 80, maxKeys: 6, maxItems: 2 },
    { depth: 0, maxStringChars: 40, maxKeys: 4, maxItems: 1 },
  ];

  // An injection hit is a property of the payload, not of which truncation
  // attempt fit — capture it from any attempt so it survives even a fall
  // through to the fallback marker (#629).
  let injection: ToolObservationInjection | undefined;

  for (const options of attempts) {
    const candidate = serializeEnvelope(
      input.ok,
      input.projected,
      input.error,
      options,
    );
    injection ??= candidate?.injection;
    if (!candidate || candidate.content.length > maxChars) continue;
    const wasTruncated =
      candidate.truncated || input.projectionWasTruncated === true;
    if (wasTruncated) outcome = 'truncated';
    return buildReducedObservation(
      candidate.content,
      outcome,
      wasTruncated,
      injection,
    );
  }

  return buildReducedObservation(
    fallbackObservation(input.ok, input.error),
    input.ok ? 'truncated' : 'fallback',
    true,
    injection,
  );
}

/** Fit an already-sanitized envelope into an allocated per-result budget. */
export function fitToolObservation(
  content: string,
  maxChars: number,
): { content: string; wasTruncated: boolean } {
  if (content.length <= maxChars) {
    return { content, wasTruncated: false };
  }

  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const ok = parsed.ok === true;
    const reduced = reduceBoundedObservation({
      projected: ok ? parsed.data : undefined,
      error: ok ? undefined : String(parsed.error ?? 'tool execution failed'),
      ok,
      maxChars,
    });
    return { content: reduced.content, wasTruncated: true };
  } catch {
    return {
      content: observationMarker('truncated'),
      wasTruncated: true,
    };
  }
}
