export interface ZaloAgentToolContext {
  zaloUserId: string;
  /** WISPACE userId if the Zalo account is linked; undefined otherwise. */
  userId?: number;
}

export interface ZaloAgentReply {
  text: string;
}

export interface ZaloAgentInput {
  zaloUserId: string;
  userId?: number;
  userText: string;
  /** Zalo message msg_id — LLM usage correlation id. */
  correlationId?: string;
}
