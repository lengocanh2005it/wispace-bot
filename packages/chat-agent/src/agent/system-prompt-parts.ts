import { sanitizeUntrustedTextForLlm } from '@wispace/llm-agent/core';

/**
 * Stand-in for a dynamic prompt part that tripped an injection pattern.
 * Neutral, and identical in shape to the existing unlinked-learner fallback, so
 * a mangled display name never surfaces to the learner as a redaction marker.
 */
const SAFE_PROMPT_PART_PLACEHOLDER = 'Chào bạn nha';

/**
 * Single consumption point for every dynamic system-prompt part — the display
 * name and the learner-profile section both flow through here.
 *
 * Secret redaction alone only covered #632 (no-secrets) and left the injection
 * half of the pipeline to each caller's own discipline, even though the system
 * message outranks the user turn in every model.
 * `sanitizeUntrustedTextForLlm` does both, and it collapses to the placeholder
 * rather than mangling the text.
 */
export function redactPromptPart(
  value: string | null | undefined,
): string | undefined {
  if (!value) {
    return undefined;
  }
  // No explicit maxChars: the sanitizer's own default is the pre-existing
  // behaviour, and a display name plus a two-fact profile section is far below
  // it. Passing a tighter cap would be a new truncation nobody asked for.
  return sanitizeUntrustedTextForLlm(value, {
    unsafePlaceholder: SAFE_PROMPT_PART_PLACEHOLDER,
  }).text;
}
