import type { BoundedToolDisclosure } from '@wispace/llm-agent/core';
import type {
  MessengerGenericElement,
  MessengerRichFollowUp,
} from '../../domain/entities/messenger-rich-message.types';
import { DEFAULT_TOPIC } from '@messenger/shared/config/poc.constants';

const TITLE_MAX = 80;
const SUBTITLE_MAX = 80;
const MAX_GENERIC_ELEMENTS = 10;

function buildDisclosureElement(
  disclosure: BoundedToolDisclosure,
): MessengerGenericElement {
  const bounds = [
    `${disclosure.limit} mục`,
    ...(disclosure.pastDays === undefined
      ? []
      : [`${disclosure.pastDays} ngày`]),
  ].join('/');
  const count =
    disclosure.count === undefined ? 'Dữ liệu' : `${disclosure.count} mục`;
  const completeness = disclosure.capped
    ? 'không trọn lịch'
    : 'chưa rõ toàn bộ';
  const scope =
    disclosure.timeRange === 'past'
      ? 'lịch đã qua'
      : disclosure.timeRange === 'upcoming'
        ? 'lịch sắp tới'
        : disclosure.timeRange === 'all'
          ? 'cả lịch'
          : undefined;
  const detail = clipMessengerLabel(
    `${scope ? `${scope}; ` : ''}${count}; tối đa ${bounds}.`,
    Math.max(1, SUBTITLE_MAX - completeness.length - 2),
  );
  return {
    title: 'Phạm vi dữ liệu',
    subtitle: `${completeness}; ${detail}`,
  };
}

function withDisclosure(
  elements: MessengerGenericElement[],
  disclosure?: BoundedToolDisclosure,
): MessengerGenericElement[] {
  if (!disclosure) return elements;
  const disclosureElement = buildDisclosureElement(disclosure);
  if (elements.length < MAX_GENERIC_ELEMENTS) {
    return [...elements, disclosureElement];
  }
  const last = elements[elements.length - 1];
  const disclosureText = disclosureElement.subtitle ?? '';
  const topicPrefix = last.subtitle?.slice(
    0,
    Math.max(0, SUBTITLE_MAX - disclosureText.length - 3),
  );
  return [
    ...elements.slice(0, -1),
    {
      ...last,
      subtitle: clipMessengerLabel(
        topicPrefix ? `${topicPrefix} · ${disclosureText}` : disclosureText,
        SUBTITLE_MAX,
      ),
    },
  ];
}

export function clipMessengerLabel(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }

  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

export function buildStudySessionsRichFollowUps(
  sessions: Array<{
    scheduledTimeLabel: string;
    topic: string;
  }>,
  disclosure?: BoundedToolDisclosure,
): MessengerRichFollowUp[] {
  if (!sessions.length && !disclosure) {
    return [];
  }

  const elements = sessions.slice(0, MAX_GENERIC_ELEMENTS).map((session) => ({
    title: clipMessengerLabel(`📅 ${session.scheduledTimeLabel}`, TITLE_MAX),
    subtitle: clipMessengerLabel(session.topic || DEFAULT_TOPIC, SUBTITLE_MAX),
  }));

  return [
    {
      kind: 'generic',
      messageType: 'CHAT_SESSIONS_GENERIC',
      elements: withDisclosure(elements, disclosure),
    },
  ];
}

export function buildCalendarEntriesRichFollowUp(
  entries: Array<{
    scheduledTimeLabel: string;
    topic?: string;
  }>,
  disclosure?: BoundedToolDisclosure,
): MessengerRichFollowUp | undefined {
  if (!entries.length && !disclosure) {
    return undefined;
  }

  return {
    kind: 'generic',
    messageType: 'CHAT_CALENDAR_GENERIC',
    elements: withDisclosure(
      entries.slice(0, MAX_GENERIC_ELEMENTS).map((entry) => ({
        title: clipMessengerLabel(`📅 ${entry.scheduledTimeLabel}`, TITLE_MAX),
        subtitle: clipMessengerLabel(
          entry.topic || DEFAULT_TOPIC,
          SUBTITLE_MAX,
        ),
      })),
      disclosure,
    ),
  };
}

export function buildUserGoalsRichFollowUp(goals: {
  targetScore: number;
  examDate: string;
}): MessengerRichFollowUp {
  return {
    kind: 'generic',
    messageType: 'CHAT_GOALS_GENERIC',
    elements: [
      {
        title: '🎯 Mục tiêu IELTS',
        subtitle: clipMessengerLabel(
          `Band ${goals.targetScore} · Ngày thi ${goals.examDate}`,
          SUBTITLE_MAX,
        ),
      },
    ],
  };
}

export function buildReminderPreviewRichFollowUp(params: {
  scheduledTimeLabel: string;
  teaser: string;
}): MessengerRichFollowUp {
  return {
    kind: 'generic',
    messageType: 'CHAT_REMINDER_GENERIC',
    elements: [
      {
        title: clipMessengerLabel(`📅 ${params.scheduledTimeLabel}`, TITLE_MAX),
        subtitle: clipMessengerLabel(params.teaser, SUBTITLE_MAX),
      },
    ],
  };
}

export function buildRescheduleSuccessRichFollowUp(params: {
  scheduledTimeLabel: string;
}): MessengerRichFollowUp {
  return {
    kind: 'generic',
    messageType: 'CHAT_RESCHEDULE_GENERIC',
    elements: [
      {
        title: '✅ Đã đổi lịch học',
        subtitle: clipMessengerLabel(params.scheduledTimeLabel, SUBTITLE_MAX),
      },
    ],
  };
}

export function buildRescheduleConfirmFollowUp(params: {
  summary: string;
  confirmationToken?: string;
}): MessengerRichFollowUp {
  const tokenSuffix = params.confirmationToken
    ? `:${params.confirmationToken}`
    : '';
  return {
    kind: 'button',
    messageType: 'CHAT_RESCHEDULE_CONFIRM',
    text: clipMessengerLabel(params.summary, 640),
    buttons: [
      {
        type: 'postback',
        title: 'Xác nhận đổi lịch',
        payload: `CONFIRM_RESCHEDULE${tokenSuffix}`,
      },
      {
        type: 'postback',
        title: 'Hủy',
        payload: `CANCEL_RESCHEDULE${tokenSuffix}`,
      },
    ],
  };
}
