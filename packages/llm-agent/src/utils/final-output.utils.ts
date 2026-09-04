import { CREDENTIAL_SHAPES } from './secret-patterns.utils';
import { buildSafetyScanCandidates } from './prompt-injection.utils';

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
  'Non-disclosure of internal details',
  'When NOT to call tools',
  'Do NOT act as a general-purpose assistant',
  'Multi-intent requests (2+ tasks in one message)',
  'Personal data — never fabricate',
] as const;

/**
 * Vendor / model identifier tokens that must never appear in a REPLY (#625) —
 * if one does, the model is disclosing which LLM powers the bot. Kept small
 * and hand-maintained; bare "ai" / "model" / "llm" / "bot" / "gpt" are NOT
 * listed (too many legitimate IELTS uses).
 * ponytail: manual denylist, extend only when a real bypass is observed (#336).
 */
const VENDOR_MODEL_PATTERNS: Array<RegExp> = [
  /\b(open\s*ai|anthropic|openrouter|together\s+ai|groq|mistral\s+ai|deepseek|minimax|azure\s+openai|aws\s+bedrock|vertex\s+ai|google\s+ai)\b/i,
  /\b(chatgpt|claude|gemini|llama|mixtral|qwen|grok)\b/i,
  /\bgpt\b/i,
  /\bgpt[-_\s]?\d/i,
  /\bclaude[-_\s]?\d/i,
  // Hyphenated model families only — bare "o3" collides with IELTS essay text (ozone, CO2).
  /\bo[134]-(?:mini|preview|pro)\b/i,
  /\bsystem\s*fingerprint\b/i,
  /\bknowledge\s+cutoff\b/i,
  /\btemperature\s*[:=]\s*\d/i,
  /\btop[_-]?p\s*[:=]/i,
];

export interface FinalOutputSafetyResult {
  unsafe: boolean;
  reason?: 'prompt_leak' | 'credential_leak' | 'vendor_leak';
}

function compactCanonicalText(text: string): string {
  // ponytail: compact only long allowlisted markers; add short-token spacing
  // rules only after a reproduced bypass to avoid false positives.
  return text.replace(/[^\p{L}\p{N}]+/gu, '');
}

function containsPromptLeakMarker(outputCandidates: string[]): boolean {
  const canonicalOutputCandidates = outputCandidates.slice(1);

  return SYSTEM_PROMPT_LEAK_MARKERS.some((marker) => {
    const markerCandidates = buildSafetyScanCandidates(marker).slice(1);
    return markerCandidates.some((markerCandidate) => {
      const compactMarker = compactCanonicalText(markerCandidate);
      return canonicalOutputCandidates.some(
        (candidate) =>
          candidate.includes(markerCandidate) ||
          compactCanonicalText(candidate).includes(compactMarker),
      );
    });
  });
}

export function checkFinalOutputSafety(text: string): FinalOutputSafetyResult {
  const outputCandidates = buildSafetyScanCandidates(text);

  if (containsPromptLeakMarker(outputCandidates)) {
    return { unsafe: true, reason: 'prompt_leak' };
  }
  for (const pattern of CREDENTIAL_SHAPES) {
    if (pattern.test(text)) {
      return { unsafe: true, reason: 'credential_leak' };
    }
  }
  for (const pattern of VENDOR_MODEL_PATTERNS) {
    if (outputCandidates.some((candidate) => pattern.test(candidate))) {
      return { unsafe: true, reason: 'vendor_leak' };
    }
  }
  return { unsafe: false };
}
