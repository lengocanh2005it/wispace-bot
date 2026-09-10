/** L3: PSID giữ nguyên, user đổi tài khoản WISPACE (ref mới). */
export function buildMappingUserIdRelinkedMessage(userId: number): string {
  return (
    `Mình đã cập nhật liên kết Messenger với tài khoản WISPACE (user #${userId}).\n\n` +
    'Từ giờ báo cáo và nhắc lịch sẽ theo tài khoản mới của bạn nhé.'
  );
}

/** L4: PSID đã map user khác — từ chối relink qua webhook. */
export function buildMappingRelinkBlockedMessage(): string {
  return (
    'Messenger này đã liên kết với một tài khoản WISPACE khác.\n\n' +
    'Nếu bạn cần đổi tài khoản, hãy mở app WISPACE → ngắt kết nối Messenger → tạo link mới.'
  );
}

/** L4: userId đã map PSID khác — một tài khoản WISPACE chỉ một Messenger. */
export function buildMappingUserLinkedOtherPsidMessage(): string {
  return (
    'Tài khoản WISPACE này đã liên kết Messenger khác.\n\n' +
    'Nếu bạn cần đổi thiết bị, hãy mở app WISPACE → ngắt kết nối Messenger → tạo link mới từ Messenger đó.'
  );
}

export function buildMessengerLinkVerifyFailedMessage(
  reason: 'NOT_FOUND' | 'EXPIRED' | 'USED' | 'INVALID_FORMAT',
): string {
  switch (reason) {
    case 'EXPIRED':
      return 'Link kết nối Messenger đã hết hạn. Vui lòng mở lại từ app WISPACE để tạo link mới nhé.';
    case 'USED':
      return 'Link kết nối Messenger đã được sử dụng. Nếu bạn chưa kết nối xong, hãy tạo link mới từ app WISPACE.';
    case 'INVALID_FORMAT':
      return 'Link kết nối Messenger không hợp lệ. Vui lòng mở lại từ app WISPACE.';
    case 'NOT_FOUND':
    default:
      return 'Không xác minh được link WISPACE. Vui lòng mở lại liên kết từ app WISPACE (nút Kết nối Messenger).';
  }
}

export function buildMessengerLinkHandoffFailedMessage(): string {
  return 'Không thể hoàn tất liên kết Messenger lúc này. Vui lòng mở lại từ app WISPACE để tạo link mới nhé.';
}
