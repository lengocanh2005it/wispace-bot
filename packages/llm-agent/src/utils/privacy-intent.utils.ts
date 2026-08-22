/**
 * Privacy intent detection — detects user requests for unlink, delete, export.
 * Used by bot message flow to trigger confirm + execute.
 */

const UNLINK_PATTERNS = [
  /(?:ngắt|ngat)\s*kết\s*nối/i,
  /unlink/i,
  /hủy\s*liên\s*kết/i,
  /huỷ\s*liên\s*kết/i,
  /disconnect/i,
  /ngưng\s*dùng/i,
  /stop\s*using/i,
] as const;

const DELETE_PATTERNS = [
  /xóa\s*(?:tài\s*khoản|data|dữ\s*liệu|toàn\s*bộ)/i,
  /delete\s*(?:account|data)/i,
  /xoá\s*(?:tài\s*khoản|data|dữ\s*liệu)/i,
  /erasure/i,
  /right\s*to\s*be\s*forgotten/i,
] as const;

const EXPORT_PATTERNS = [
  /tải\s*(?:về|dữ\s*liệu|data)/i,
  /export\s*(?:data|account)/i,
  /download\s*(?:my\s*)?data/i,
  /right\s*to\s*portability/i,
  /trích\s*xuất/i,
] as const;

export type PrivacyIntent = 'unlink' | 'delete' | 'export' | null;

/**
 * Detect privacy-related intent from user text.
 * Returns the intent type or null if not a privacy request.
 */
export function detectPrivacyIntent(userText: string): PrivacyIntent {
  const text = userText.trim();

  if (UNLINK_PATTERNS.some((p) => p.test(text))) {
    return 'unlink';
  }
  if (DELETE_PATTERNS.some((p) => p.test(text))) {
    return 'delete';
  }
  if (EXPORT_PATTERNS.some((p) => p.test(text))) {
    return 'export';
  }

  return null;
}

/**
 * Check if user response confirms a pending privacy action.
 * Matches Vietnamese and English confirmation phrases.
 */
export function isConfirmationResponse(userText: string): boolean {
  const text = userText.trim().toLowerCase();
  return /^(?:có|yes|ok|oke|okay|đồng\s*ý|chắc\s*chắn|confirm|y)$/.test(text);
}

/**
 * Check if user response cancels a pending privacy action.
 * Matches Vietnamese and English cancellation phrases.
 */
export function isCancellationResponse(userText: string): boolean {
  const text = userText.trim().toLowerCase();
  return /^(?:không|no|cancel|hủy|huỷ|bỏ|thoát|exit|n)$/.test(text);
}
