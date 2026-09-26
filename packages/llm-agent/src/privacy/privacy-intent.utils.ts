import { normalizeScopeText } from '../scope.utils';

/**
 * Privacy intent detection — detects explicit unlink, delete, and export
 * requests. Arbitrary text must not arm a destructive action.
 */

const MAX_PRIVACY_REQUEST_CHARS = 80;
const REQUEST_PREFIXES = [
  '',
  'minh muon ',
  'toi muon ',
  'cho minh ',
  'giup minh ',
  'giup toi ',
  'lam on ',
  'hay ',
  'please ',
  'i want to ',
] as const;
const REQUEST_SUFFIXES = [
  '',
  ' nhe',
  ' nha',
  ' a',
  ' ngay',
  ' now',
  ' please',
  ' giup minh',
  ' giup toi',
] as const;

const UNLINK_REQUESTS = [
  'ngat ket noi',
  'ngat ket noi tai khoan',
  'huy lien ket',
  'huy lien ket tai khoan',
  'unlink',
  'unlink my account',
  'disconnect',
  'disconnect my account',
  'ngung dung',
  'stop using',
] as const;

const DELETE_REQUESTS = [
  'xoa tai khoan',
  'xoa tai khoan cua toi',
  'xoa data',
  'xoa du lieu',
  'xoa du lieu cua toi',
  'xoa toan bo',
  'xoa toan bo du lieu',
  'xoa toan bo du lieu cua toi',
  'delete account',
  'delete data',
  'delete my data',
] as const;

const EXPORT_REQUESTS = [
  'tai ve',
  'tai data',
  'tai du lieu',
  'tai ve data',
  'tai ve du lieu',
  'export data',
  'export account',
  'download data',
  'download my data',
  'trich xuat',
  'trich xuat du lieu',
] as const;

const INTERROGATIVE_MARKS = /[?？⁉‼﹖﹗⸮¿]/u;
const INTERROGATIVE_PARTICLE = /(?:^|[ \t\r\n])à[ \t\r\n]*[.!?。！？]*$/iu;
const AMBIGUOUS_UNACCENTED_A = /(?:^|[ \t\r\n])a[ \t\r\n]*[.!。！]*$/iu;
const SAFE_PRIVACY_TEXT = /^[\p{L}\p{N} \t\r\n.!。！]+$/u;

export type PrivacyAction = 'unlink' | 'delete' | 'export';
export type PrivacyIntent = PrivacyAction | null;

const CONFIRMATION_SUFFIXES = ['', ' nhe', ' nha', ' a'] as const;

function withPoliteSuffixes(phrases: readonly string[]): string[] {
  return phrases.flatMap((phrase) =>
    CONFIRMATION_SUFFIXES.map((suffix) => `${phrase}${suffix}`),
  );
}

const CONFIRMATION_RESPONSES: Record<PrivacyAction, readonly string[]> = {
  unlink: withPoliteSuffixes([
    'dong y ngat ket noi',
    'xac nhan ngat ket noi',
    'confirm unlink',
  ]),
  delete: withPoliteSuffixes([
    'dong y xoa du lieu',
    'dong y xoa toan bo du lieu',
    'xac nhan xoa du lieu',
    'xac nhan xoa toan bo du lieu',
    'confirm delete',
  ]),
  export: withPoliteSuffixes([
    'dong y tai du lieu',
    'dong y tai ve du lieu',
    'xac nhan tai du lieu',
    'confirm export',
  ]),
};

const CANCELLATION_RESPONSES = new Set(
  withPoliteSuffixes([
    'khong',
    'no',
    'cancel',
    'huy',
    'bo',
    'thoat',
    'exit',
    'n',
  ]),
);

function matchesExplicitRequest(
  normalizedText: string,
  requests: readonly string[],
): boolean {
  return requests.some((request) =>
    REQUEST_PREFIXES.some((prefix) =>
      REQUEST_SUFFIXES.some(
        (suffix) => normalizedText === `${prefix}${request}${suffix}`,
      ),
    ),
  );
}

function isBlockedPrivacyText(userText: string): boolean {
  const normalizedForm = userText.normalize('NFC');
  const trimmedForm = normalizedForm.trim();
  return (
    !SAFE_PRIVACY_TEXT.test(normalizedForm) ||
    INTERROGATIVE_MARKS.test(trimmedForm) ||
    INTERROGATIVE_PARTICLE.test(trimmedForm) ||
    AMBIGUOUS_UNACCENTED_A.test(trimmedForm)
  );
}

/**
 * Detect privacy-related intent from an explicit request.
 * Returns null for keywords embedded in arbitrary text.
 */
export function detectPrivacyIntent(userText: string): PrivacyIntent {
  const normalizedInput = userText.normalize('NFC');
  if (
    normalizedInput.length > MAX_PRIVACY_REQUEST_CHARS ||
    isBlockedPrivacyText(normalizedInput)
  ) {
    return null;
  }

  const text = normalizeScopeText(normalizedInput);
  if (!text) {
    return null;
  }

  if (matchesExplicitRequest(text, UNLINK_REQUESTS)) {
    return 'unlink';
  }
  if (matchesExplicitRequest(text, DELETE_REQUESTS)) {
    return 'delete';
  }
  if (matchesExplicitRequest(text, EXPORT_REQUESTS)) {
    return 'export';
  }

  return null;
}

/**
 * Check if user response deliberately confirms a pending privacy action.
 * Bare acknowledgements such as "ok" never confirm an action.
 */
export function isConfirmationResponse(
  userText: string,
  intent: PrivacyAction,
): boolean {
  if (isBlockedPrivacyText(userText)) {
    return false;
  }

  return CONFIRMATION_RESPONSES[intent].includes(normalizeScopeText(userText));
}

/**
 * Check if user response cancels a pending privacy action.
 * Vietnamese and English forms accept no-diacritic text and polite suffixes.
 */
export function isCancellationResponse(userText: string): boolean {
  if (isBlockedPrivacyText(userText)) {
    return false;
  }

  return CANCELLATION_RESPONSES.has(normalizeScopeText(userText));
}
