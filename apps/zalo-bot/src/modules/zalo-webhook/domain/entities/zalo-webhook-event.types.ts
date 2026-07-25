export type ZaloWebhookEventName =
  | 'user_send_text'
  | 'user_send_image'
  | 'user_send_sticker'
  | 'user_send_file'
  | 'user_send_location'
  | 'follow'
  | 'unfollow'
  | 'oa_send_text'
  | 'oa_send_image'
  | 'oa_send_list'
  | 'oa_send_file'
  | 'oa_send_sticker';

export interface ZaloWebhookEvent {
  app_id: string;
  event_name: ZaloWebhookEventName;
  timestamp: string;
  sender?: { id: string };
  recipient?: { id: string };
  follower?: { id: string };
  oa_id?: string;
  user_id_by_app?: string;
  message?: {
    text?: string;
    msg_id?: string;
  };
}
