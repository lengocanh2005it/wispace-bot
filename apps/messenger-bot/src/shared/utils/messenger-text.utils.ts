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
    return paragraphs.slice(0, maxBubbles);
  }

  if (paragraphs.length === 1 && trimmed.length <= maxCharsPerBubble) {
    return [trimmed];
  }

  const bubbles: string[] = [];
  let current = '';

  const pushCurrent = () => {
    if (!current) {
      return;
    }
    bubbles.push(current);
    current = '';
  };

  for (const paragraph of paragraphs) {
    if (bubbles.length >= maxBubbles) {
      break;
    }

    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxCharsPerBubble) {
      current = candidate;
      continue;
    }

    pushCurrent();
    if (bubbles.length >= maxBubbles) {
      break;
    }

    if (paragraph.length <= maxCharsPerBubble) {
      current = paragraph;
      continue;
    }

    for (
      let offset = 0;
      offset < paragraph.length;
      offset += maxCharsPerBubble
    ) {
      if (bubbles.length >= maxBubbles) {
        break;
      }
      bubbles.push(paragraph.slice(offset, offset + maxCharsPerBubble));
    }
  }

  pushCurrent();

  if (!bubbles.length) {
    return [trimmed.slice(0, maxCharsPerBubble)];
  }

  if (bubbles.length > maxBubbles) {
    return bubbles.slice(0, maxBubbles);
  }

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
