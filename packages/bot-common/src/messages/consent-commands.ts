/**
 * Deterministic consent commands for scheduled notifications (#596).
 *
 * Consent is a legal surface — it must never depend on LLM intent detection.
 * Parsers on all three platforms call this BEFORE the agent pipeline; a match
 * consumes the message without touching quota or the LLM.
 */

export type ConsentFeature = 'report' | 'reminder';
export type ConsentAction = 'enable' | 'disable';

export interface ConsentCommand {
  feature: ConsentFeature;
  action: ConsentAction;
}

/** Lowercase, strip diacritics, collapse whitespace — one canonical form. */
export function normalizeConsentText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!?,;:]+$/g, '');
}

// ponytail: exact-match phrase list, extend when real users use other wordings.
const ENABLE_PHRASES: Record<ConsentFeature, readonly string[]> = {
  report: [
    'bat bao cao',
    'bat report',
    'dang ky bao cao',
    'nhan bao cao',
    'on bao cao',
    'on report',
  ],
  reminder: [
    'bat nhac hoc',
    'bat nhac',
    'dang ky nhac hoc',
    'nhan nhac hoc',
    'on nhac hoc',
    'on nhac',
  ],
};

const DISABLE_PHRASES: Record<ConsentFeature, readonly string[]> = {
  report: [
    'tat bao cao',
    'tat report',
    'huy bao cao',
    'huy dang ky bao cao',
    'dung bao cao',
    'off bao cao',
    'off report',
  ],
  reminder: [
    'tat nhac hoc',
    'tat nhac',
    'huy nhac hoc',
    'dung nhac hoc',
    'off nhac hoc',
    'off nhac',
  ],
};

function findPhrase(
  normalized: string,
  table: Record<ConsentFeature, readonly string[]>,
  action: ConsentAction,
): ConsentCommand | null {
  for (const feature of ['report', 'reminder'] as const) {
    if (table[feature].includes(normalized)) {
      return { feature, action };
    }
  }
  return null;
}

/** Exact-match (normalized) consent command, or null when not a command. */
export function parseConsentCommand(text: string): ConsentCommand | null {
  const normalized = normalizeConsentText(text);
  if (!normalized) return null;
  return (
    findPhrase(normalized, ENABLE_PHRASES, 'enable') ??
    findPhrase(normalized, DISABLE_PHRASES, 'disable')
  );
}
