import { readHttpsUrl } from '@wispace/bot-common/utils';
import { isAgentToolName } from '../agent.tools';
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
}

interface SummaryIdentifier {
  toolName: string;
  field: 'calendarId' | 'exerciseUrl';
  value: string;
}

interface SummaryExtraction {
  line?: string;
  identifiers: SummaryIdentifier[];
}

type RecordValue = Record<string, unknown>;

const IDENTIFIER_FIELD_ORDER: Record<SummaryIdentifier['field'], number> = {
  calendarId: 0,
  exerciseUrl: 1,
};

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
  return number !== undefined && Number.isInteger(number) && number >= 0
    ? number
    : undefined;
}

function readCalendarId(value: unknown): string | undefined {
  const number = readFiniteNumber(value);
  return number !== undefined && Number.isInteger(number) && number > 0
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

function extractCalendarSummary(
  toolName: string,
  data: RecordValue,
): SummaryExtraction {
  const preferredKey =
    toolName === 'list_study_calendar_entries' ? 'entries' : 'sessions';
  const fallbackKey = preferredKey === 'entries' ? 'sessions' : 'entries';
  const items =
    readItems(data, preferredKey) ?? readItems(data, fallbackKey) ?? [];
  const count =
    readNonNegativeInteger(data.count) ??
    (Array.isArray(data[preferredKey]) || Array.isArray(data[fallbackKey])
      ? items.length
      : undefined);
  const nearest = readNearestLabel(items);
  const fields: string[] = [];
  if (count !== undefined) fields.push(`count=${count}`);
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
    identifiers,
  };
}

function extractSummary(
  toolName: string,
  content: string,
): SummaryExtraction | undefined {
  if (!SUMMARY_TOOL_NAMES.has(toolName)) return undefined;
  const data = readObservationData(content);
  if (!data) return undefined;

  if (
    toolName === 'get_upcoming_study_sessions' ||
    toolName === 'list_study_calendar_entries'
  ) {
    return extractCalendarSummary(toolName, data);
  }

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
      identifiers: [],
    };
  }

  const status = readStatus(data.status);
  const exerciseUrl = readExerciseUrl(data.exerciseUrl);
  if (!status && !exerciseUrl) return undefined;
  return {
    ...(status ? { line: `${toolName}: status=${status}` } : {}),
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

/** Build the bounded, advisory history summary for one agent turn. */
export function buildToolSummary(
  toolNames: readonly string[],
  observations: readonly ToolSummaryObservation[],
): string | undefined {
  const names = [...new Set(toolNames.filter(isAgentToolName))];
  if (names.length === 0) return undefined;

  const linesByTool = new Map<string, string | undefined>();
  const identifiers = new Map<string, SummaryIdentifier>();

  for (const observation of observations) {
    if (!observation.succeeded) continue;
    const extracted = extractSummary(observation.toolName, observation.content);
    if (!extracted) continue;

    // A successful but empty structured result is a reliable replacement for
    // an older line; failed/truncated observations never overwrite one.
    linesByTool.set(observation.toolName, extracted.line);
    for (const identifier of extracted.identifiers) {
      identifiers.set(identifierText(identifier), identifier);
    }
  }

  const lines = [`[Đã tra cứu: ${names.join('; ')}]`];
  appendSection(
    lines,
    '[Kết quả]',
    names.flatMap((name) => {
      const line = linesByTool.get(name);
      return line ? [line] : [];
    }),
  );
  appendSection(
    lines,
    '[Identifiers]',
    [...identifiers.values()].sort(compareIdentifiers).map(identifierText),
  );

  return lines.join('\n');
}
