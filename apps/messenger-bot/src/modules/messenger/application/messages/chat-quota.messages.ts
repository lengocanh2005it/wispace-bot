export function buildChatQuotaDeniedMessage(dailyLimit: number): string {
  return (
    `Hôm nay bạn đã dùng hết ${dailyLimit} lượt chat với WISPACE. ` +
    `Lượt mới reset lúc 00:00 (giờ Việt Nam).\n` +
    `Báo cáo tiến độ và nhắc lịch học WISPACE vẫn gửi tự động.\n` +
    `Bạn vẫn có thể dùng Menu: Đăng ký báo cáo.`
  );
}

export function buildChatBurstLimitMessage(burstPerMinute: number): string {
  return (
    `Bạn gửi tin hơi nhanh. Vui lòng đợi khoảng một phút rồi thử lại ` +
    `(tối đa ${burstPerMinute} lượt chat/phút).`
  );
}

export function buildChatQuotaDenyMessage(
  reason: 'DAILY_LIMIT' | 'BURST_LIMIT',
  limit: number,
): string {
  if (reason === 'BURST_LIMIT') {
    return buildChatBurstLimitMessage(limit);
  }

  return buildChatQuotaDeniedMessage(limit);
}

export function buildChatQuotaRemainingHintMessage(remaining: number): string {
  return (
    `Hôm nay bạn còn ${remaining} lượt chat với WISPACE ` +
    `(reset 00:00 giờ Việt Nam).`
  );
}
