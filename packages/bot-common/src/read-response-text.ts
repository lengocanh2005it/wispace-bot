const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024;

/** Read an upstream response without allowing an unbounded error body. */
export async function readResponseText(
  response: Response,
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('maxBytes must be a positive safe integer');
  }

  if (!response.body) {
    if (typeof response.text === 'function') {
      return response.text();
    }

    if (typeof response.json === 'function') {
      return JSON.stringify(await response.json());
    }

    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';

  try {
    while (totalBytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;

      const remaining = maxBytes - totalBytes;
      const chunk =
        value.byteLength > remaining ? value.subarray(0, remaining) : value;
      totalBytes += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });

      if (chunk.byteLength < value.byteLength) {
        await reader.cancel();
        break;
      }
    }

    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
