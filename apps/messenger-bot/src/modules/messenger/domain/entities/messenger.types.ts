export type NotificationCadence = 'DAILY' | 'WEEKLY' | 'MONTHLY';

export interface MessengerReferral {
  ref?: string;
  source?: string;
  type?: string;
}

export interface MessengerOptin {
  type?: string;
  payload?: string;
  notification_messages_token?: string;
  notification_messages_status?: string;
  topic?: string;
  frequency?: NotificationCadence;
  ref?: string;
  title?: string;
}

export interface MessengerWebhookEvent {
  sender?: {
    id?: string;
  };
  /** Millisecond timestamp of the delivery — stable across Meta redeliveries. */
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    sticker_id?: number;
    attachments?: Array<{
      type?: string;
      payload?: {
        url?: string;
        sticker_id?: number;
      };
    }>;
    referral?: MessengerReferral;
  };
  postback?: {
    payload?: string;
    referral?: MessengerReferral;
  };
  referral?: MessengerReferral;
  optin?: MessengerOptin;
}

export interface MessengerWebhookPayload {
  object?: string;
  entry?: Array<{
    messaging?: MessengerWebhookEvent[];
  }>;
}

export interface UserMessengerMapping {
  id: number;
  userId?: number;
  psid?: string;
  notificationMessagesToken: string;
  cadence?: NotificationCadence;
  topic?: string;
  status: 'ACTIVE' | 'INACTIVE';
  mappingGeneration?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessengerMessageLog {
  id: number;
  userId?: number;
  psid?: string;
  messageType: string;
  status: 'SENT' | 'FAILED';
  errorMessage?: string;
  createdAt: string;
}
