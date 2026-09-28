export type ClarificationChoice = 'progress' | 'schedule' | 'reschedule';

export type ClarificationIrrelevantAction = 'clarify' | 'reset_menu' | 'clear';

const DIACRITIC_MARKS = /[\u0300-\u036f]/g;

/** Normalize Vietnamese text for the small, deterministic clarification parser. */
export function normalizeClarificationText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/đ/gi, 'd')
    .replace(DIACRITIC_MARKS, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const CANCEL_WORDS = new Set([
  'bo',
  'bo qua',
  'cancel',
  'dung',
  'huy',
  'khong can',
  'khong',
  'n',
  'no',
  'skip',
  'thoat',
]);

const CHOICE_ALIASES: ReadonlyArray<
  readonly [ClarificationChoice, ...string[]]
> = [
  [
    'progress',
    'chon mot',
    '1',
    'mot',
    'tien do',
    'progress',
    'first',
    '1st',
    'first one',
    'the first one',
    'cai thu 1',
    'cai thu nhat',
    'lua chon thu nhat',
    'chon 1',
    'option 1',
    'choice 1',
    'lua chon 1',
    'td',
  ],
  [
    'schedule',
    'chon hai',
    '2',
    'hai',
    'lich',
    'lich hoc',
    'schedule',
    'second',
    '2nd',
    'second one',
    'the second one',
    'cai thu 2',
    'cai thu hai',
    'lua chon thu hai',
    'chon 2',
    'option 2',
    'choice 2',
    'lua chon 2',
    'lh',
  ],
  [
    'reschedule',
    'chon ba',
    '3',
    'ba',
    'doi lich',
    'doi lai lich',
    'reschedule',
    'third',
    '3rd',
    'third one',
    'the third one',
    'cai thu 3',
    'cai thu ba',
    'lua chon thu ba',
    'chon 3',
    'option 3',
    'choice 3',
    'lua chon 3',
    'dl',
  ],
];

const EXPLICIT_CHOICE_ALIASES: ReadonlyArray<
  readonly [ClarificationChoice, ...string[]]
> = [
  [
    'progress',
    '1',
    'mot',
    'first',
    '1st',
    'first one',
    'the first one',
    'cai thu 1',
    'cai thu nhat',
    'lua chon thu nhat',
    'chon mot',
    'chon 1',
    'option 1',
    'choice 1',
    'lua chon 1',
    'td',
  ],
  [
    'schedule',
    '2',
    'hai',
    'second',
    '2nd',
    'second one',
    'the second one',
    'cai thu 2',
    'cai thu hai',
    'lua chon thu hai',
    'chon hai',
    'chon 2',
    'option 2',
    'choice 2',
    'lua chon 2',
    'lh',
  ],
  [
    'reschedule',
    '3',
    'ba',
    'third',
    '3rd',
    'third one',
    'the third one',
    'cai thu 3',
    'cai thu ba',
    'lua chon thu ba',
    'chon ba',
    'chon 3',
    'option 3',
    'choice 3',
    'lua chon 3',
    'dl',
  ],
];

function isChoiceSuffix(value: string): boolean {
  return /^(?:nhe|nha|a|di|voi|giup minh|cho minh)$/.test(value);
}

export function parseChoice(text: string): ClarificationChoice | null {
  const normalized = normalizeClarificationText(text);
  if (!normalized) return null;

  for (const [choice, ...aliases] of CHOICE_ALIASES) {
    if (aliases.includes(normalized)) return choice;
    const parts = normalized.split(' ');
    for (const alias of aliases) {
      const aliasParts = alias.split(' ');
      const suffix = parts.slice(aliasParts.length).join(' ');
      if (
        parts.length > aliasParts.length &&
        parts.slice(0, aliasParts.length).join(' ') === alias &&
        isChoiceSuffix(suffix)
      ) {
        return choice;
      }
    }
  }
  return null;
}

/** Multiple offered choices in one batch are contradictory, not an intent. */
export function isContradictory(text: string): boolean {
  const lines = text.split(/\r?\n/);
  const lineChoices = lines
    .map((line) => parseChoice(line))
    .filter((choice): choice is ClarificationChoice => choice !== null);
  if (new Set(lineChoices).size > 1) return true;

  const tokens = normalizeClarificationText(text).split(' ').filter(Boolean);
  if (tokens.length === 0) return false;

  let matches = 0;
  for (const [, ...aliases] of EXPLICIT_CHOICE_ALIASES) {
    const matched = aliases.some((alias) => {
      const aliasTokens = alias.split(' ');
      return tokens.some((_, index) =>
        aliasTokens.every((token, offset) => tokens[index + offset] === token),
      );
    });
    if (matched) matches += 1;
  }
  if (matches > 1) return true;

  const normalized = tokens.join(' ');
  const hasProgress = /\b(?:tien do|progress|score|diem|band)\b/.test(
    normalized,
  );
  const hasReschedule =
    /\b(?:reschedule|move|change)\b/.test(normalized) ||
    /\bdoi(?: lai)?\b.*\b(?:lich|buoi|session)\b/.test(normalized);
  const hasScheduleTopic = /\blic?h(?: hoc)?\b/.test(normalized);
  const hasScheduleView =
    hasScheduleTopic &&
    /\b(?:xem|check|view|upcoming|schedule|calendar)\b/.test(normalized);
  const hasJoiner =
    /\b(?:va|and|hoac|or)\b/.test(normalized) || /[,;\n]/.test(text);

  return (
    (hasProgress && (hasScheduleView || hasReschedule)) ||
    (hasReschedule && hasScheduleView) ||
    (hasProgress && hasScheduleTopic && hasJoiner) ||
    (hasJoiner && hasScheduleTopic && hasReschedule)
  );
}

export function isCancel(text: string): boolean {
  return CANCEL_WORDS.has(normalizeClarificationText(text));
}
