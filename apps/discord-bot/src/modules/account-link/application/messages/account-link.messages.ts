import { buildGreetingMessage } from '@wispace/bot-common';

export function buildDiscordLinkWelcomeMessage(displayName?: string): string {
  return buildGreetingMessage(displayName);
}

/**
 * Sent to the Discord account when its link is re-assigned to a different
 * WISPACE user (#137 item 5). The previous WISPACE user is displaced and can
 * no longer receive Discord reports/reminders.
 */
export function buildDiscordRelinkNoticeMessage(): string {
  return `⚠️ Liên kết Discord này vừa được gắn sang một tài khoản WISPACE khác. Tài khoản WISPACE trước đó sẽ không còn nhận báo cáo và nhắc lịch học qua Discord nữa. Nếu bạn không thực hiện thao tác này, hãy liên hệ đội ngũ WISPACE để được hỗ trợ.`;
}
