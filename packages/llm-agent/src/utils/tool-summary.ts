import { readHttpsUrl } from '@wispace/bot-common/utils';
import { isAgentToolName, type BoundedToolDisclosure } from '../agent.tools';
import { sanitizeUntrustedTextForLlm } from './prompt-injection.utils';

const MAX_TOOL_SUMMARY_CHARS = 8_000;
const MAX_RESULT_VALUE_CHARS = 256;
const MAX_IDENTIFIER_CHARS = 2_048;

const SUMMARY_TOOL_NAMES = new Set([
  'get_user_goals',
  'get_upcoming_study_sessions',
  'list_study_calendar_entries',
  'precreate_next_exercise',
]);
const PRECREATE_STATUS_VALUES = new Set([
  'created',
  'already_exists',
  'finished_all',
  'no_roadmap',
]);

export interface ToolSummaryObservation {
  toolName: string;
  content: string;
  succeeded: boolean;
  boundedDisclosure?: BoundedToolDisclosure;
}

interface SummaryIdentifier {
  toolName: string;
  field: 'calendarId' | 'exerciseUrl';
  value: string;
}

interface SummaryExtraction {
  line?: string;
  scopeKey: string;
  identifiers: SummaryIdentifier[];
}

type RecordValue = Record<string, unknown>;

const IDENTIFIER_FIELD_ORDER: Record<SummaryIdentifier['field'], number> = {
  calendarId: 0,
  exerciseUrl: 1,
};
const MIN_MERGEABLE_SUMMARY_FIELDS = new Set([
  'requestedLimit',
  'effectiveLimit',
  'requestedPastDays',
  'effectivePastDays',
]);

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSafeText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;

  // Tool observations have already crossed the normal sanitizer boundary.
  // Re-apply the same scalar hygiene here so a future observation producer
  // cannot inject a value into the history summary formatter.
  const sanitized = sanitizeUntrustedTextForLlm(text, { maxChars });
  if (sanitized.reason) return undefined;
  const result = sanitized.text.trim();
  return result || undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  const number = readFiniteNumber(value);
  return number !== undefined && Number.isSafeInteger(number) && number >= 0
    ? number
    : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  const number = readFiniteNumber(value);
  return number !== undefined && Number.isSafeInteger(number) && number > 0
    ? number
    : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readCompleteness(
  value: unknown,
): 'incomplete' | 'unknown' | undefined {
  return value === 'incomplete' || value === 'unknown' ? value : undefined;
}

function readTimeRange(
  value: unknown,
): 'upcoming' | 'past' | 'all' | undefined {
  return value === 'upcoming' || value === 'past' || value === 'all'
    ? value
    : undefined;
}

function readCalendarId(value: unknown): string | undefined {
  const number = readFiniteNumber(value);
  return number !== undefined && Number.isSafeInteger(number) && number > 0
    ? String(number)
    : undefined;
}

function readStatus(value: unknown): string | undefined {
  const status = readSafeText(value, MAX_RESULT_VALUE_CHARS);
  return status && PRECREATE_STATUS_VALUES.has(status) ? status : undefined;
}

function readExerciseUrl(value: unknown): string | undefined {
  const url = readSafeText(value, MAX_IDENTIFIER_CHARS);
  if (!url) return undefined;
  try {
    return readHttpsUrl(url);
  } catch {
    return undefined;
  }
}

function readObservationData(content: string): RecordValue | undefined {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed) || parsed.ok !== true || parsed._observation) {
      return undefined;
    }
    if (!isRecord(parsed.data) || parsed.data._observation) {
      return undefined;
    }
    return parsed.data;
  } catch {
    return undefined;
  }
}

function readCalendarObservationData(
  content: string,
): { data: RecordValue; truncated: boolean } | undefined {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.data)) {
      return undefined;
    }
    const compactBounded =
      parsed.ok === undefined &&
      readBoolean(parsed.data.capped) !== undefined &&
      (readTimeRange(parsed.data.timeRange) !== undefined ||
        readNonNegativeInteger(parsed.data.count) !== undefined);
    if (parsed.ok !== true && !compactBounded) return undefined;
    const observation = parsed._observation ?? parsed.data._observation;
    if (observation !== undefined && observation !== 'truncated') {
      return undefined;
    }
    return {
      data: parsed.data,
      truncated: compactBounded || observation === 'truncated',
    };
  } catch {
    return undefined;
  }
}

function readItems(
  data: RecordValue,
  key: 'sessions' | 'entries',
): RecordValue[] | undefined {
  const value = data[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter(isRecord);
}

function readNearestLabel(items: RecordValue[]): string | undefined {
  let nearest:
    | { item: RecordValue; timestamp: number; index: number }
    | undefined;

  items.forEach((item, index) => {
    const iso = readSafeText(item.scheduledAtIso, MAX_RESULT_VALUE_CHARS);
    if (!iso) return;
    const timestamp = Date.parse(iso);
    if (!Number.isFinite(timestamp)) return;
    if (
      !nearest ||
      timestamp < nearest.timestamp ||
      (timestamp === nearest.timestamp && index < nearest.index)
    ) {
      nearest = { item, timestamp, index };
    }
  });

  const candidates = nearest ? [nearest.item] : items;
  for (const item of candidates) {
    const label = readSafeText(item.scheduledTimeLabel, MAX_RESULT_VALUE_CHARS);
    if (label) return label;
    const iso = readSafeText(item.scheduledAtIso, MAX_RESULT_VALUE_CHARS);
    if (iso) return iso;
  }

  return undefined;
}

function calendarScopeKey(toolName: string, data: RecordValue): string {
  const timeRange =
    toolName === 'get_upcoming_study_sessions'
      ? 'upcoming'
      : (readTimeRange(data.timeRange) ?? 'unknown');
  return JSON.stringify([
    timeRange,
    readPositiveInteger(data.requestedLimit),
    readPositiveInteger(data.effectiveLimit),
    readPositiveInteger(data.requestedPastDays),
    readPositiveInteger(data.effectivePastDays),
    readNonNegativeInteger(data.count),
  ]);
}

function extractCalendarSummary(
  toolName: string,
  data: RecordValue,
  truncated = false,
  disclosure?: BoundedToolDisclosure,
): SummaryExtraction {
  const summaryData = disclosure
    ? {
        ...data,
        timeRange:
          data.timeRange ??
          disclosure.timeRange ??
          (toolName === 'get_upcoming_study_sessions' ? 'upcoming' : undefined),
        count: disclosure.count ?? data.count,
        requestedLimit: disclosure.requestedLimit ?? data.requestedLimit,
        effectiveLimit: disclosure.limit,
        requestedPastDays:
          disclosure.requestedPastDays ?? data.requestedPastDays,
        effectivePastDays: disclosure.pastDays ?? data.effectivePastDays,
        capped: disclosure.capped,
        completeness: disclosure.completeness,
      }
    : data;
  const preferredKey =
    toolName === 'list_study_calendar_entries' ? 'entries' : 'sessions';
  const fallbackKey = preferredKey === 'entries' ? 'sessions' : 'entries';
  const items = truncated
    ? []
    : (readItems(summaryData, preferredKey) ??
      readItems(summaryData, fallbackKey) ??
      []);
  const count =
    readNonNegativeInteger(summaryData.count) ??
    (truncated
      ? undefined
      : Array.isArray(summaryData[preferredKey]) ||
          Array.isArray(summaryData[fallbackKey])
        ? items.length
        : undefined);
  const nearest = truncated ? undefined : readNearestLabel(items);
  const fields: string[] = [];
  const timeRange = readTimeRange(summaryData.timeRange);
  if (timeRange) fields.push(`timeRange=${timeRange}`);
  if (count !== undefined) fields.push(`count=${count}`);

  const capped = readBoolean(summaryData.capped);
  const completeness = readCompleteness(summaryData.completeness);
  if (capped !== undefined || completeness !== undefined) {
    const requestedLimit = readPositiveInteger(summaryData.requestedLimit);
    const effectiveLimit = readPositiveInteger(summaryData.effectiveLimit);
    const requestedPastDays = readPositiveInteger(
      summaryData.requestedPastDays,
    );
    const effectivePastDays = readPositiveInteger(
      summaryData.effectivePastDays,
    );
    if (requestedLimit !== undefined) {
      fields.push(`requestedLimit=${requestedLimit}`);
    }
    if (effectiveLimit !== undefined) {
      fields.push(`effectiveLimit=${effectiveLimit}`);
    }
    if (requestedPastDays !== undefined) {
      fields.push(`requestedPastDays=${requestedPastDays}`);
    }
    if (effectivePastDays !== undefined) {
      fields.push(`effectivePastDays=${effectivePastDays}`);
    }
    if (capped !== undefined) fields.push(`capped=${capped}`);
    if (completeness !== undefined) {
      fields.push(`completeness=${completeness}`);
    }
  }

  if (nearest) fields.push(`nearest=${nearest}`);

  const identifiers: SummaryIdentifier[] = [];
  for (const item of items) {
    const calendarId = readCalendarId(item.calendarId);
    if (calendarId) {
      identifiers.push({ toolName, field: 'calendarId', value: calendarId });
    }
  }

  return {
    ...(fields.length > 0 ? { line: `${toolName}: ${fields.join('; ')}` } : {}),
    scopeKey: calendarScopeKey(toolName, summaryData),
    identifiers,
  };
}

function extractSummary(
  toolName: string,
  content: string,
  boundedDisclosure?: BoundedToolDisclosure,
): SummaryExtraction | undefined {
  if (!SUMMARY_TOOL_NAMES.has(toolName)) return undefined;

  if (
    toolName === 'get_upcoming_study_sessions' ||
    toolName === 'list_study_calendar_entries'
  ) {
    const calendarData = readCalendarObservationData(content);
    return calendarData || boundedDisclosure
      ? extractCalendarSummary(
          toolName,
          calendarData?.data ?? {},
          calendarData?.truncated ?? true,
          boundedDisclosure,
        )
      : undefined;
  }

  const data = readObservationData(content);
  if (!data) return undefined;

  if (toolName === 'get_user_goals') {
    const fields: string[] = [];
    const targetScore = readFiniteNumber(data.targetScore);
    if (targetScore !== undefined) fields.push(`targetScore=${targetScore}`);
    const examDate = readSafeText(data.examDate, MAX_RESULT_VALUE_CHARS);
    if (examDate) fields.push(`examDate=${examDate}`);
    return {
      ...(fields.length > 0
        ? { line: `${toolName}: ${fields.join('; ')}` }
        : {}),
      scopeKey: 'default',
      identifiers: [],
    };
  }

  const status = readStatus(data.status);
  const exerciseUrl = readExerciseUrl(data.exerciseUrl);
  if (!status && !exerciseUrl) return undefined;
  return {
    ...(status ? { line: `${toolName}: status=${status}` } : {}),
    scopeKey: 'default',
    identifiers: exerciseUrl
      ? [{ toolName, field: 'exerciseUrl', value: exerciseUrl }]
      : [],
  };
}

function identifierText(identifier: SummaryIdentifier): string {
  return `${identifier.toolName}.${identifier.field}=${identifier.value}`;
}

function compareIdentifiers(
  left: SummaryIdentifier,
  right: SummaryIdentifier,
): number {
  return (
    IDENTIFIER_FIELD_ORDER[left.field] - IDENTIFIER_FIELD_ORDER[right.field] ||
    left.toolName.localeCompare(right.toolName) ||
    left.value.localeCompare(right.value)
  );
}

function appendSection(
  lines: string[],
  heading: string,
  sectionLines: readonly string[],
): void {
  let headingAdded = false;
  for (const line of sectionLines) {
    const candidate = [...lines, ...(headingAdded ? [] : [heading]), line];
    if (candidate.join('\n').length > MAX_TOOL_SUMMARY_CHARS) continue;
    if (!headingAdded) {
      lines.push(heading);
      headingAdded = true;
    }
    lines.push(line);
  }
}

function mergeCappedSummaryLines(
  toolName: string,
  previous: string,
  next: string,
): string {
  const prefix = `${toolName}: `;
  const fields = [
    ...previous.slice(prefix.length).split('; '),
    ...next.slice(prefix.length).split('; '),
  ];
  const values = new Map<string, Set<string>>();
  for (const field of fields) {
    const key = field.split('=', 1)[0];
    const current = values.get(key) ?? new Set<string>();
    current.add(field);
    values.set(key, current);
  }
  const mergedFields = [...values.entries()]
    .map(([key, fieldValues]): string | undefined => {
      if (fieldValues.size === 1) return [...fieldValues][0];
      if (key === 'count' || !MIN_MERGEABLE_SUMMARY_FIELDS.has(key)) {
        return undefined;
      }
      const numbers = [...fieldValues]
        .map((field) => Number(field.slice(key.length + 1)))
        .filter((value) => Number.isFinite(value));
      return numbers.length === fieldValues.size
        ? `${key}=${Math.min(...numbers)}`
        : undefined;
    })
    .filter((field): field is string => field !== undefined);
  return `${prefix}${mergedFields.join('; ')}`;
}

/** Build the bounded, advisory history summary for one agent turn. */
export function buildToolSummary(
  toolNames: readonly string[],
  observations: readonly ToolSummaryObservation[],
): string | undefined {
  const names = [...new Set(toolNames.filter(isAgentToolName))];
  if (names.length === 0) return undefined;

  const linesByTool = new Map<string, Map<string, string>>();
  const identifiers = new Map<string, SummaryIdentifier>();

  for (const observation of observations) {
    if (!observation.succeeded) continue;
    const extracted = extractSummary(
      observation.toolName,
      observation.content,
      observation.boundedDisclosure,
    );
    if (!extracted) continue;

    const toolLines =
      linesByTool.get(observation.toolName) ?? new Map<string, string>();
    if (extracted.line !== undefined) {
      const previous = toolLines.get(extracted.scopeKey);
      if (
        previous?.includes('capped=true') === true &&
        extracted.line.includes('capped=true')
      ) {
        toolLines.set(
          extracted.scopeKey,
          mergeCappedSummaryLines(
            observation.toolName,
            previous,
            extracted.line,
          ),
        );
      } else if (previous?.includes('capped=true') !== true) {
        toolLines.set(extracted.scopeKey, extracted.line);
      }
      linesByTool.set(observation.toolName, toolLines);
    }
    for (const identifier of extracted.identifiers) {
      identifiers.set(identifierText(identifier), identifier);
    }
  }

  const lines = [`[Đã tra cứu: ${names.join('; ')}]`];
  appendSection(
    lines,
    '[Kết quả]',
    names.flatMap((name) => [...(linesByTool.get(name)?.values() ?? [])]),
  );
  appendSection(
    lines,
    '[Identifiers]',
    [...identifiers.values()].sort(compareIdentifiers).map(identifierText),
  );

  return lines.join('\n');
}
