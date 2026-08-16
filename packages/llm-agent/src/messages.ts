export const CHAT_FAILURE_FALLBACK_MESSAGE =
  'Xin lỗi, mình gặp sự cố khi xử lý tin nhắn. Bạn thử lại sau ít phút nhé.';

export function buildPromptInjectionBlockedMessage(): string {
  return (
    'Mình không thể xử lý tin nhắn này.\n\n' +
    'Bạn có thể hỏi về tiến độ học, lịch học IELTS, hoặc đăng ký báo cáo nhé.'
  );
}

export function buildWispaceScopeRedirectMessage(): string {
  return (
    'Mình chỉ hỗ trợ các câu hỏi về WISPACE và IELTS Writing thôi nhé.\n\n' +
    'Bạn có thể hỏi ví dụ: tiến độ học của mình, lịch học sắp tới, cách luyện Task 1/2, hoặc đăng ký báo cáo trước ngày thi.'
  );
}

export function buildGroundingBlockedMessage(): string {
  return (
    'Mình cần tra cứu dữ liệu để trả lời chính xác hơn. ' +
    'Bạn vui lòng thử lại nhé.'
  );
}

export function buildPrecreateExerciseUnavailableMessage(): string {
  return 'Hiện chưa thể tạo bài tập mới. Bạn thử lại sau ít phút nhé.';
}

/**
 * Fail-closed reply when one model round asks for more distinct tool calls
 * than the per-round cap allows (#162) — nothing is executed.
 */
export function buildToolCallCapMessage(): string {
  return 'Mình chỉ xử lý được tối đa 4 việc cùng lúc. Bạn hỏi lại từng việc nhé.';
}

/**
 * Learner-friendly labels for tools that returned data — used by the
 * exhaustion partial answer. Server-controlled, never raw tool names.
 */
const TOOL_LABELS: Record<string, string> = {
  get_learning_progress_report: 'báo cáo tiến độ',
  get_user_goals: 'mục tiêu band và ngày thi',
  get_upcoming_study_sessions: 'lịch học sắp tới',
  list_study_calendar_entries: 'lịch học',
  reschedule_study_session: 'thông tin đổi lịch',
  preview_next_study_reminder: 'tin nhắn nhắc buổi học',
  register_exam_report_notifications: 'đăng ký nhận báo cáo',
  precreate_next_exercise: 'thông tin bài tập mới',
};

const UNKNOWN_TOOL_LABEL = 'dữ liệu liên quan';

/**
 * Partial answer for the exhaustion path (#207 item 4): instead of the
 * generic failure, tells the learner WHICH grounded data was retrieved
 * (only tools that actually returned data — grounding-safe by construction)
 * and asks for a more specific question. Never renders raw tool results.
 */
export function buildExhaustionPartialAnswer(
  groundedToolNames: string[],
): string {
  const labels = [...new Set(groundedToolNames)].map(
    (name) => TOOL_LABELS[name] ?? UNKNOWN_TOOL_LABEL,
  );
  if (labels.length === 0) {
    return 'Mình chưa tổng hợp xong câu trả lời. Bạn thử lại hoặc hỏi rõ hơn nhé.';
  }
  return (
    `Đã lấy được dữ liệu: ${labels.join(', ')}. ` +
    'Mình chưa tổng hợp xong — bạn thử lại hoặc hỏi rõ một mục nhé.'
  );
}
