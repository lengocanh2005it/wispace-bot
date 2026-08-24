import { Type } from 'class-transformer';
import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

const ZALO_EVENT_NAMES = [
  'user_send_text',
  'user_send_image',
  'user_send_sticker',
  'user_send_file',
  'user_send_location',
  'follow',
  'unfollow',
  'oa_send_text',
  'oa_send_image',
  'oa_send_list',
  'oa_send_file',
  'oa_send_sticker',
] as const;

type ZaloWebhookEventName = (typeof ZALO_EVENT_NAMES)[number];

// --- Leaf DTOs (no nested references) ---

class ZaloSenderIdDto {
  @IsString()
  @MaxLength(64)
  id: string;
}

class ZaloRecipientIdDto {
  @IsString()
  @MaxLength(64)
  id: string;
}

class ZaloFollowerIdDto {
  @IsString()
  @MaxLength(64)
  id: string;
}

class ZaloMessageDto {
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  text?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  msg_id?: string;
}

// --- Event DTO ---

/** Runtime-validated Zalo webhook DTO — replaces the erased TS interface. */
export class ZaloWebhookEventDto {
  @IsString()
  @MaxLength(64)
  app_id: string;

  @IsEnum(ZALO_EVENT_NAMES)
  event_name: ZaloWebhookEventName;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timestamp?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ZaloSenderIdDto)
  sender?: ZaloSenderIdDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ZaloRecipientIdDto)
  recipient?: ZaloRecipientIdDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ZaloFollowerIdDto)
  follower?: ZaloFollowerIdDto;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  oa_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  user_id_by_app?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ZaloMessageDto)
  message?: ZaloMessageDto;
}
