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
