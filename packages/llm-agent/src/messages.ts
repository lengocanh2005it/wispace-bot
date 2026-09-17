import {
  deriveAgentToolMap,
  isAgentToolName,
  type AgentToolMap,
} from './agent.tools';

export const CHAT_FAILURE_FALLBACK_MESSAGE =
  'Xin lỗi, mình gặp sự cố khi xử lý tin nhắn. Bạn thử lại sau ít phút nhé.';

/**
 * Standard non-disclosure reply (#625) — re-exported from `@wispace/bot-common`
 * (the leaf package) so `@wispace/llm-agent` consumers and the bot gateways
 * share ONE constant. Used for any internal-details probe and for the
 * self-intro path; it must never vary by framing.
 */
export {
  NON_DISCLOSURE_REPLY,
  buildNonDisclosureReply,
} from '@wispace/bot-common/messages';

export function buildPromptInjectionBlockedMessage(): string {
  return (
    'Mình không thể xử lý tin nhắn này.\n\n' +
    'Bạn có thể hỏi về tiến độ học, lịch học IELTS, hoặc đăng ký báo cáo nhé.'
  );
}

/**
 * Fixed calm response for hostility aimed at the assistant (#974).
 * Keep this stable so a future classifier can reuse the same learner-facing
 * copy instead of inventing a second deflection.
 */
export function buildHostilityDeflectionMessage(): string {
  return 'Mình ở đây để hỗ trợ bạn luyện IELTS Writing. Bạn muốn hỏi gì về bài viết của mình?';
}

/**
 * Verified national crisis support resource text (#982).
 * National Child Protection Hotline 111 (Tổng đài Quốc gia Bảo vệ Trẻ em 111),
 * free 24/7 counseling and support in Vietnam.
 */
export const CRISIS_SUPPORT_RESOURCE_MESSAGE =
  'Bạn có thể gọi Tổng đài Quốc gia Bảo vệ Trẻ em 111 — miễn phí, hoạt động 24/7 — để được tư vấn và hỗ trợ.';

/**
 * Single-sourced crisis support handoff reply (#1054 / #982).
 * Approved 2-sentence response: brief Vietnamese acknowledgement followed by
 * the verified 111 resource statement.
 */
export function buildCrisisSupportHandoffMessage(): string {
  return `Mình rất tiếc vì bạn đang trải qua điều này. ${CRISIS_SUPPORT_RESOURCE_MESSAGE}`;
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

export function buildClarificationMessage(): string {
  return (
    'Mình chưa rõ bạn muốn hỏi gì. Bạn có thể hỏi về:\n' +
    '• Tiến độ học IELTS\n' +
    '• Lịch học sắp tới\n' +
    '• Đổi lịch học\n' +
    'Trả lời 1, 2 hoặc 3; hoặc nhắn “Hủy” để bỏ qua.'
  );
}

export function buildClarificationCancelledMessage(): string {
  return 'Đã hủy phần làm rõ. Khi cần, bạn cứ gửi câu hỏi mới nhé.';
}

/**
 * Honest stop acknowledgement (#959): the learner asked to stop — until
 * in-flight cancellation exists (#960), say that plainly instead of a
 * clarification menu that implies the message was not understood. Shared
 * by all three bots.
 */
export function buildStopAcknowledgedMessage(): string {
  return (
    'Mình đã nhận được yêu cầu dừng của bạn.\n' +
    'Câu trả lời đang được tạo không thể dừng giữa chừng, nhưng bạn cứ nhắn "tiếp" khi muốn mình làm tiếp nhé.'
  );
}

export function buildClarificationUnavailableMessage(): string {
  return 'Mình chưa thể xử lý lựa chọn lúc này. Bạn thử lại sau ít phút nhé.';
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
 * Fail-closed reply when the final-output guardrail detects system-prompt
 * or credential leakage in an LLM reply (#165) — the suspect text is never
 * sent to the learner.
 */
export function buildFinalOutputBlockedMessage(): string {
  return 'Mình chưa thể gửi nội dung này. Bạn thử lại nhé.';
}

/**
 * Learner-friendly labels for tools that returned data — used by the
 * exhaustion partial answer. Server-controlled, never raw tool names.
 */
const TOOL_LABELS: AgentToolMap<string> = deriveAgentToolMap(
  (tool) => tool.metadata.learnerLabel,
);

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
  const labels = [...new Set(groundedToolNames)].map((name) =>
    isAgentToolName(name) ? TOOL_LABELS[name] : UNKNOWN_TOOL_LABEL,
  );
  if (labels.length === 0) {
    return 'Mình chưa tổng hợp xong câu trả lời. Bạn thử lại hoặc hỏi rõ hơn nhé.';
  }
  return (
    `Đã lấy được dữ liệu: ${labels.join(', ')}. ` +
    'Mình chưa tổng hợp xong — bạn thử lại hoặc hỏi rõ một mục nhé.'
  );
}

/**
 * Learner-facing action labels for the mutating tools — used by the
 * per-user write-tool budget denial copy (#626). Server-controlled.
 */
const WRITE_TOOL_ACTION_LABELS: AgentToolMap<string | undefined> =
  deriveAgentToolMap((tool) =>
    tool.metadata.budget === 'write' ? tool.metadata.writeAction : undefined,
  );

function writeToolAction(toolName: string): string {
  return isAgentToolName(toolName)
    ? (WRITE_TOOL_ACTION_LABELS[toolName] ?? 'thao tác này')
    : 'thao tác này';
}

/**
 * Relayable result when a learner has used up a mutating tool's per-day
 * budget (#626). Not an error — the model paraphrases it as a normal limit.
 */
export function buildWriteToolDailyBudgetMessage(toolName: string): string {
  return (
    `Bạn đã dùng hết số lần ${writeToolAction(toolName)} trong hôm nay rồi. ` +
    'Bạn thử lại vào ngày mai nhé.'
  );
}

/**
 * Relayable result when one learner message asks for more repetitions of a
 * mutating tool than the per-message cap allows (#626).
 */
export function buildWriteToolPerMessageBudgetMessage(
  toolName: string,
  limit: number,
): string {
  return (
    `Trong một tin nhắn mình chỉ xử lý được tối đa ${limit} lần ` +
    `${writeToolAction(toolName)} thôi. Bạn nhắn lại phần còn lại giúp mình nhé.`
  );
}
