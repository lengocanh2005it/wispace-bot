export function getNoUpcomingStudySessionMessage(
  minutesBefore: number,
): string {
  return `Hiện chưa có buổi học sắp tới trong lịch của bạn. Hãy đặt lịch trên WISPACE để nhận lời nhắc tự động trước ${minutesBefore} phút nhé!`;
}

export function getStudyReminderLeadTimeNotice(minutesBefore: number): string {
  return `Bạn sẽ nhận tin nhắn nhắc lịch học trước ${minutesBefore} phút khi đến giờ buổi học nhé.`;
}
