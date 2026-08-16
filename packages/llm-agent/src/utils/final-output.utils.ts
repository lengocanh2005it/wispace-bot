/**
 * Final-output safety guardrail (#165): the last thing an LLM-generated
 * reply passes through before delivery. Input scanning and tool-result
 * sanitization can miss a direct or indirect injection response — this check
 * catches the model leaking system-prompt/instruction material or
 * credential-shaped content, and the caller fails closed to a generic reply.
 */

/** Distinctive system-prompt markers — if any appears in a REPLY, the model
 * is leaking instruction material. Kept in sync with CHAT_SYSTEM_PROMPT_CORE
 * by the marker-sync spec (a prompt edit breaks the spec deliberately). */
export const SYSTEM_PROMPT_LEAK_MARKERS = [
  'You are the WISPACE assistant',
  'WISPACE scope (mandatory)',
  'OUT-OF-SCOPE questions',
  'When NOT to call tools',
  'Do NOT act as a general-purpose assistant',
  'Multi-intent requests (2+ tasks in one message)',
  'Personal data — never fabricate',
] as const;

const CREDENTIAL_PATTERNS: Array<RegExp> = [
  // OpenAI-style keys.
  /\bsk-[A-Za-z0-9]{16,}\b/i,
  // Bearer tokens.
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}\b/i,
  // Explicit secret assignments (api_key/password/secret = value).
  /\b(?:api[_-]?key|password|passwd|secret)\s*[:=]\s*\S{8,}\b/i,
];

export interface FinalOutputSafetyResult {
  unsafe: boolean;
  reason?: 'prompt_leak' | 'credential_leak';
}

export function checkFinalOutputSafety(text: string): FinalOutputSafetyResult {
  for (const marker of SYSTEM_PROMPT_LEAK_MARKERS) {
    if (text.includes(marker)) {
      return { unsafe: true, reason: 'prompt_leak' };
    }
  }
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) {
      return { unsafe: true, reason: 'credential_leak' };
    }
  }
  return { unsafe: false };
}
