import { NotificationCadence } from '../../modules/messenger/domain/entities/messenger.types';

const VALID_CADENCES: NotificationCadence[] = ['DAILY', 'WEEKLY', 'MONTHLY'];

/** Defaults when Messenger webhook only sends ref (Get Started / m.me). */
export const POC_DEFAULT_LINK_TOPIC = 'IELTS';

/** Default study-session topic when the Wispace calendar record has none. */
export const DEFAULT_TOPIC = 'IELTS Writing';
export const POC_DEFAULT_LINK_CADENCE: NotificationCadence = 'WEEKLY';

export interface MessengerLinkContext {
  ref: string;
  topic: string;
  cadence: NotificationCadence;
  userId: number;
}

export function parseUserIdFromRef(ref?: string | null): number | undefined {
  if (!ref?.trim()) {
    return undefined;
  }

  const parsed = Number.parseInt(ref.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function isValidCadence(
  value?: string | null,
): value is NotificationCadence {
  return (
    !!value &&
    VALID_CADENCES.includes(value.trim().toUpperCase() as NotificationCadence)
  );
}

export function normalizeCadence(value: string): NotificationCadence {
  return value.trim().toUpperCase() as NotificationCadence;
}

export function parseMessengerLinkContext(input: {
  ref?: string | null;
  topic?: string | null;
  cadence?: string | null;
}): MessengerLinkContext | undefined {
  const ref = input.ref?.trim();
  const userId = parseUserIdFromRef(ref);
  if (!userId) {
    return undefined;
  }

  const topic = input.topic?.trim() || POC_DEFAULT_LINK_TOPIC;
  const cadenceInput = input.cadence?.trim() || POC_DEFAULT_LINK_CADENCE;

  if (!isValidCadence(cadenceInput)) {
    return undefined;
  }

  return {
    ref: ref!,
    topic,
    cadence: normalizeCadence(cadenceInput),
    userId,
  };
}

export function buildPocPsidToken(psid: string): string {
  return `poc:psid:${psid}`;
}

export const FALLBACK_DISPLAY_NAME = 'Chào bạn nha';

export function buildWelcomeMessage(
  displayName: string = FALLBACK_DISPLAY_NAME,
): string {
  const name = displayName.trim();
  if (!name || name === FALLBACK_DISPLAY_NAME) {
    return `Chào bạn nha! Mình là trợ lý WISPACE. Bạn có thể hỏi về tiến độ học, lịch học sắp tới, hoặc đăng ký báo cáo trước ngày thi — cứ nhắn tự nhiên nhé.`;
  }

  return `Chào ${name}! Mình là trợ lý WISPACE. Bạn có thể hỏi về tiến độ học, lịch học sắp tới, hoặc đăng ký báo cáo trước ngày thi — cứ nhắn tự nhiên nhé.`;
}

export function getPocSubscriptionConfirmationMessage(): string {
  return 'Bạn đã đăng ký nhận báo cáo học tập. WISPACE sẽ gửi báo cáo AI qua Messenger khoảng 2–3 ngày trước ngày thi của bạn.';
}

export function getPocAlreadySubscribedMessage(): string {
  return 'Bạn đã đăng ký nhận báo cáo học tập rồi. WISPACE sẽ gửi báo cáo AI khoảng 2–3 ngày trước ngày thi — không cần bấm lại.';
}
