/**
 * Messenger does not render Markdown — strip common markers so users do not see literal * or **.
 */
// ponytail: byte-identical to llm-agent's sanitizeReplyText — reuse instead of copying
export { sanitizeReplyText as sanitizeMessengerText } from '@wispace/llm-agent';

/** Split long replies into Messenger-sized bubbles (Meta recommends short messages). */
export function splitMessengerBubbles(
  text: string,
  maxBubbles = 4,
  maxCharsPerBubble = 640,
): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const paragraphs = trimmed
    .split(/\n\n+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (
    paragraphs.length > 1 &&
    paragraphs.every((part) => part.length <= maxCharsPerBubble)
  ) {
    return markTruncated(
      paragraphs.slice(0, maxBubbles),
      paragraphs.length > maxBubbles,
    );
  }

  if (paragraphs.length === 1 && trimmed.length <= maxCharsPerBubble) {
    return [trimmed];
  }

  const bubbles: string[] = [];
  let current = '';
  let droppedTail = false;

  const pushCurrent = () => {
    if (!current) {
      return;
    }
    bubbles.push(current);
    current = '';
  };

  for (const paragraph of paragraphs) {
    if (bubbles.length >= maxBubbles) {
      droppedTail = true;
      break;
    }

    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxCharsPerBubble) {
      current = candidate;
      continue;
    }

    pushCurrent();
    if (bubbles.length >= maxBubbles) {
      droppedTail = true;
      break;
    }

    if (paragraph.length <= maxCharsPerBubble) {
      current = paragraph;
      continue;
    }

    let offset = 0;
    for (; offset < paragraph.length; offset += maxCharsPerBubble) {
      if (bubbles.length >= maxBubbles) {
        droppedTail = true;
        break;
      }
      bubbles.push(paragraph.slice(offset, offset + maxCharsPerBubble));
    }
    droppedTail = offset < paragraph.length;
  }

  pushCurrent();

  if (!bubbles.length) {
    return [
      trimmed.length > maxCharsPerBubble
        ? `${trimmed.slice(0, maxCharsPerBubble - 1).trimEnd()}…`
        : trimmed,
    ];
  }

  if (bubbles.length > maxBubbles) {
    return markTruncated(bubbles.slice(0, maxBubbles), true);
  }

  return markTruncated(bubbles, droppedTail);
}

/** Appends a continuation marker to the last bubble when content was dropped. */
function markTruncated(bubbles: string[], truncated: boolean): string[] {
  if (!truncated || bubbles.length === 0) {
    return bubbles;
  }
  const last = bubbles[bubbles.length - 1];
  bubbles[bubbles.length - 1] = `${last.replace(/\s+$/, '')}…`;
  return bubbles;
}

export function mergeChatUserTexts(texts: string[]): string {
  const parts = texts.map((text) => text.trim()).filter(Boolean);
  if (!parts.length) {
    return '';
  }

  if (parts.length === 1) {
    return parts[0];
  }

  return parts.map((text, index) => `${index + 1}. ${text}`).join('\n');
}

const MERGED_TEXT_TRUNCATION_SUFFIX =
  '\n\n… (mình chỉ xử lý phần đầu tin nhắn của bạn nhé)';

/** Keeps raw parts aligned with the visible prefix when the numbered merge is capped. */
export function capMergedChatUserTextParts(
  texts: readonly string[],
  maxChars: number,
): string[] {
  const parts = texts.map((text) => text.trim()).filter(Boolean);
  const merged = mergeChatUserTexts(parts);
  if (!merged || merged.length <= maxChars) {
    return parts;
  }

  const suffix =
    maxChars > MERGED_TEXT_TRUNCATION_SUFFIX.length
      ? MERGED_TEXT_TRUNCATION_SUFFIX
      : '…';
  let remaining = Math.max(maxChars - suffix.length, 1);
  const bounded: string[] = [];

  for (const [index, part] of parts.entries()) {
    const prefixLength = `${index + 1}. `.length;
    const separatorLength = index > 0 ? 1 : 0;
    const available = remaining - prefixLength - separatorLength;
    if (available <= 0) break;

    const clipped = part.slice(0, available);
    if (clipped) {
      bounded.push(clipped);
    }
    remaining -= prefixLength + separatorLength + clipped.length;
    if (clipped.length < part.length) break;
  }

  return bounded;
}

/** H5: limit token abuse from debounce-merged burst messages. */
export function capMergedChatUserText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length <= maxChars) {
    return trimmed;
  }

  const suffix =
    maxChars > MERGED_TEXT_TRUNCATION_SUFFIX.length
      ? MERGED_TEXT_TRUNCATION_SUFFIX
      : '…';
  const budget = Math.max(maxChars - suffix.length, 1);

  return `${trimmed.slice(0, budget).trimEnd()}${suffix}`;
}
