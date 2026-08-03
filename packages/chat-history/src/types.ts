export interface ChatHistoryMessage {
  role: 'user' | 'assistant' | 'tool_summary';
  content: string;
}
