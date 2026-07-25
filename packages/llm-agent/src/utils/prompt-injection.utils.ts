export interface InjectionCheckResult {
  isInjection: boolean;
  reason?: string;
}

/** Max chars before we treat a message as a potential token-overflow attack. */
const MAX_USER_TEXT_LENGTH = 2000;
const MAX_UNTRUSTED_TEXT_CHARS = 1000;
const MAX_SANITIZED_TOOL_RESULT_CHARS = 8000;
const UNSAFE_TEXT_PLACEHOLDER = '[redacted unsafe instruction-like text]';
const TRUNCATED_SUFFIX = '... [truncated]';

function stripUnsafeControlChars(text: string): string {
  return Array.from(text)
    .map((char) => {
      const code = char.charCodeAt(0);
      const isAllowedWhitespace = code === 9 || code === 10 || code === 13;
      const isUnsafeControl =
        !isAllowedWhitespace && ((code >= 0 && code <= 31) || code === 127);
      return isUnsafeControl ? ' ' : char;
    })
    .join('');
}

/**
 * Unicode confusable characters that can bypass Latin-only regex patterns.
 * Maps Cyrillic/Greek lookalikes to their Latin equivalents.
 */
const CONFUSABLE_MAP: Record<string, string> = {
  '\u0430': 'a', // Cyrillic а
  '\u0435': 'e', // Cyrillic е
  '\u043E': 'o', // Cyrillic о
  '\u0440': 'p', // Cyrillic р
  '\u0441': 'c', // Cyrillic с
  '\u0443': 'y', // Cyrillic у → approximate to y
  '\u0445': 'x', // Cyrillic х
  '\u0456': 'i', // Ukrainian і
  '\u03B1': 'a', // Greek α
  '\u03B5': 'e', // Greek ε
  '\u03BF': 'o', // Greek ο
  '\u03C1': 'p', // Greek ρ
};

function normalizeConfusables(text: string): string {
  return Array.from(text)
    .map((char) => CONFUSABLE_MAP[char] ?? char)
    .join('');
}

function normalizeForPromptScan(text: string): string {
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u200B-\u200F\uFEFF]/g, '')
    .replace(/[""]/g, '"')
    .replace(/['']/g, "'")
    .replace(/\s+/g, ' ')
    .toLowerCase();
  return normalizeConfusables(normalized);
}

/**
 * Patterns that strongly indicate prompt injection attempts.
 * Each entry: [pattern, reason label]
 */
const INJECTION_PATTERNS: Array<[RegExp, string]> = [
  // Instruction override
  [
    /ignore\s+(all\s+)?(previous|prior|above|earlier|old)\s+instructions?/i,
    'instruction_override',
  ],
  [
    /disregard\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
    'instruction_override',
  ],
  [
    /forget\s+(everything|all\s+instructions?|your\s+instructions?)/i,
    'instruction_override',
  ],
  [
    /bỏ\s*qua\s+(mọi\s+)?(hướng\s*dẫn|lệnh)\s*(trước|cũ|trên)/i,
    'instruction_override',
  ],
  [
    /(?:tu|từ)\s+giờ\s+(?:trở\s+đi|tro\s+di)?\s*(?:bạn|ban|mày|may)?\s*(?:là|la|hãy|hay|phải|phai)/i,
    'instruction_override',
  ],
  [
    /(?:quên|quen)\s+(?:hết|het|mọi|moi|tất\s*cả|tat\s*ca)\s+(?:hướng\s*dẫn|huong\s*dan|lệnh|lenh|chỉ\s*dẫn|chi\s*dan)/i,
    'instruction_override',
  ],

  // Injected role markers — checked before persona_override to get correct reason
  [/\n\s*#{1,3}\s*system\b/i, 'injected_role_marker'],
  [/\n\s*<\s*system\s*>/i, 'injected_role_marker'],
  [/\n\s*\[\s*system\s*\]/i, 'injected_role_marker'],
  [/```\s*system\b/i, 'injected_role_marker'],
  [/\n\s*system\s*:\s*\n/i, 'injected_role_marker'],
  [
    /(?:^|\n)\s*(?:system|developer|assistant|tool)\s*:/i,
    'injected_role_marker',
  ],
  [
    /(?:^|\n)\s*(?:hệ\s*thống|he\s*thong|nhà\s*phát\s*triển|nha\s*phat\s*trien)\s*:/i,
    'injected_role_marker',
  ],

  // Role / persona override
  [
    /you\s+are\s+now\s+(a\s+|an\s+)?(?!WISPACE|a\s+helpful)/i,
    'persona_override',
  ],
  // "act as" — only flag when implying AI persona override, not general usage
  [
    /act\s+as\s+(a\s+|an\s+)?(unrestricted|different|other|new|another|alternative|evil|free|uncensored|dangerous|DAN|hacker|malicious|unfiltered)/i,
    'persona_override',
  ],
  [/pretend\s+(you\s+are|to\s+be)/i, 'persona_override'],
  [/roleplay\s+as/i, 'persona_override'],
  [/from\s+now\s+on\s+(you\s+are|act|respond|behave)/i, 'persona_override'],
  [
    /developer\s+mode|jailbreak\s+mode|unrestricted\s+mode/i,
    'persona_override',
  ],
  [
    /(?:chế\s*độ|che\s*do)\s+(?:developer|nhà\s*phát\s*triển|nha\s*phat\s*trien|jailbreak|không\s*giới\s*hạn|khong\s*gioi\s*han)/i,
    'persona_override',
  ],
  [
    /(?:đóng\s*vai|dong\s*vai|giả\s*vờ|gia\s*vo)\s+(?:là|la)\s+(?!trợ\s*lý\s*WISPACE|tro\s*ly\s*WISPACE)/i,
    'persona_override',
  ],
  [/\bDAN\b.*(?:do\s+anything|jailbreak)/i, 'persona_override'],

  // System prompt extraction
  [/reveal\s+(your\s+)?(system\s*prompt|instructions?|prompt)/i, 'extraction'],
  [/show\s+me\s+(your\s+)?(system\s*prompt|instructions?)/i, 'extraction'],
  [
    /what\s+(are\s+your|is\s+your)\s+(system\s*prompt|instructions?)/i,
    'extraction',
  ],
  [/print\s+(your\s+)?(system\s*prompt|instructions?)/i, 'extraction'],
  [
    /repeat\s+(your\s+)?(system\s*prompt|instructions?|previous\s+message)/i,
    'extraction',
  ],
  [
    /(?:tiết\s*lộ|tiet\s*lo|hiển\s*thị|hien\s*thi|in\s+ra|nhắc\s*lại|nhac\s*lai)\s+(?:system\s*prompt|prompt\s*hệ\s*thống|prompt\s*he\s*thong|hướng\s*dẫn\s*ẩn|huong\s*dan\s*an|chỉ\s*dẫn\s*ẩn|chi\s*dan\s*an|lệnh\s*ẩn|lenh\s*an)/i,
    'extraction',
  ],
  [
    /(?:prompt|hướng\s*dẫn|huong\s*dan|chỉ\s*dẫn|chi\s*dan|lệnh|lenh)\s+(?:ẩn|an|hệ\s*thống|he\s*thong)\s+(?:của|cua)\s+(?:bạn|ban)/i,
    'extraction',
  ],

  // Prompt delimiter injection
  [/\n\s*(human|user|assistant|ai)\s*:\s*\n/i, 'delimiter_injection'],
  [/<\|im_start\|>|<\|im_end\|>/i, 'delimiter_injection'],
  [/\[INST\]|\[\/INST\]/i, 'delimiter_injection'],
];

/** Detects repetition-based context flooding (e.g. "abc " × 50). */
function hasRepetitionFlood(text: string): boolean {
  // A token of 3+ distinct chars repeated >25 times consecutively
  return /([^\s]{3,20}\s*)\1{25,}/i.test(text);
}

function scanPatterns(text: string): InjectionCheckResult {
  if (hasRepetitionFlood(text)) {
    return { isInjection: true, reason: 'repetition_flood' };
  }

  const candidates = [text, normalizeForPromptScan(text)];
  for (const [pattern, reason] of INJECTION_PATTERNS) {
    if (candidates.some((candidate) => pattern.test(candidate))) {
      return { isInjection: true, reason };
    }
  }

  return { isInjection: false };
}

/** Check user-supplied input — applies length limit + pattern scan. */
export function detectPromptInjection(userText: string): InjectionCheckResult {
  const text = userText ?? '';

  if (text.length > MAX_USER_TEXT_LENGTH) {
    return { isInjection: true, reason: 'message_too_long' };
  }

  return scanPatterns(text);
}

export function sanitizeUntrustedTextForLlm(
  value: string,
  options?: { maxChars?: number; unsafePlaceholder?: string },
): { text: string; wasSanitized: boolean; reason?: string } {
  const withoutControlChars = stripUnsafeControlChars(value).trim();
  const check = scanPatterns(withoutControlChars);

  if (check.isInjection) {
    return {
      text: options?.unsafePlaceholder ?? UNSAFE_TEXT_PLACEHOLDER,
      wasSanitized: true,
      reason: check.reason,
    };
  }

  const normalized = withoutControlChars.replace(/\s+/g, ' ').trim();
  const maxChars = options?.maxChars ?? MAX_UNTRUSTED_TEXT_CHARS;
  if (normalized.length > maxChars) {
    const suffix =
      maxChars > TRUNCATED_SUFFIX.length ? TRUNCATED_SUFFIX : '...';
    return {
      text: `${normalized.slice(0, maxChars - suffix.length).trimEnd()}${suffix}`,
      wasSanitized: true,
      reason: 'text_too_long',
    };
  }

  return { text: normalized, wasSanitized: normalized !== value };
}

function sanitizeUntrustedValueForLlm(value: unknown): {
  value: unknown;
  wasSanitized: boolean;
  reason?: string;
} {
  if (typeof value === 'string') {
    const result = sanitizeUntrustedTextForLlm(value, {
      maxChars: MAX_SANITIZED_TOOL_RESULT_CHARS,
    });
    return {
      value: result.text,
      wasSanitized: result.wasSanitized,
      reason: result.reason,
    };
  }

  if (Array.isArray(value)) {
    let wasSanitized = false;
    let reason: string | undefined;
    const sanitized = value.map((entry) => {
      const result = sanitizeUntrustedValueForLlm(entry);
      wasSanitized ||= result.wasSanitized;
      reason ??= result.reason;
      return result.value;
    });
    return { value: sanitized, wasSanitized, reason };
  }

  if (value && typeof value === 'object') {
    let wasSanitized = false;
    let reason: string | undefined;
    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const result = sanitizeUntrustedValueForLlm(entry);
      sanitized[key] = result.value;
      wasSanitized ||= result.wasSanitized;
      reason ??= result.reason;
    }
    return { value: sanitized, wasSanitized, reason };
  }

  return { value, wasSanitized: false };
}

/** Check and sanitize tool result content before feeding it back to the LLM. */
export function sanitizeToolResultContent(content: string): {
  content: string;
  wasSanitized: boolean;
  reason?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const sanitizedText = sanitizeUntrustedTextForLlm(content, {
      maxChars: MAX_SANITIZED_TOOL_RESULT_CHARS,
    });
    return {
      content: sanitizedText.text,
      wasSanitized: sanitizedText.wasSanitized,
      reason: sanitizedText.reason,
    };
  }

  const sanitizedValue = sanitizeUntrustedValueForLlm(parsed);
  let sanitizedContent = JSON.stringify(sanitizedValue.value);
  let wasSanitized = sanitizedValue.wasSanitized;
  let reason = sanitizedValue.reason;

  const serializedCheck = scanPatterns(sanitizedContent);
  if (serializedCheck.isInjection) {
    return {
      content: JSON.stringify({ _sanitized: true }),
      wasSanitized: true,
      reason: serializedCheck.reason,
    };
  }

  if (sanitizedContent.length > MAX_SANITIZED_TOOL_RESULT_CHARS) {
    sanitizedContent = JSON.stringify({
      _truncated: true,
      preview: sanitizedContent.slice(0, MAX_SANITIZED_TOOL_RESULT_CHARS),
    });
    wasSanitized = true;
    reason ??= 'tool_result_too_long';
  }

  return {
    content: sanitizedContent,
    wasSanitized,
    reason,
  };
}
