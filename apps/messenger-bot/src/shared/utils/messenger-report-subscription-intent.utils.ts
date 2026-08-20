import { detectPromptInjection } from '@wispace/llm-agent';

const EXPLICIT_REPORT_SUBSCRIPTION_INTENTS = [
  /\bdang ky(?: nhan)? bao cao\b/u,
  /\bmuon (?:dang ky )?nhan bao cao tu dong\b/u,
];
const NEGATED_REPORT_SUBSCRIPTION_INTENTS = [
  /\bkhong (?:muon|can) (?:dang ky )?(?:nhan )?bao cao(?: tu dong)?\b/u,
  /\bkhong dang ky (?:nhan )?bao cao(?: tu dong)?\b/u,
];

function normalizeMessengerReportIntent(userText: string): string {
  return userText
    .trim()
    .replace(/\s+/gu, ' ')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/đ/gu, 'd');
}

export function hasMessengerReportSubscriptionIntent(
  userText: string | undefined,
): boolean {
  const text = userText ?? '';
  if (detectPromptInjection(text).isInjection) {
    return false;
  }

  const normalized = normalizeMessengerReportIntent(text);
  if (
    NEGATED_REPORT_SUBSCRIPTION_INTENTS.some((pattern) =>
      pattern.test(normalized),
    )
  ) {
    return false;
  }

  return EXPLICIT_REPORT_SUBSCRIPTION_INTENTS.some((pattern) =>
    pattern.test(normalized),
  );
}
