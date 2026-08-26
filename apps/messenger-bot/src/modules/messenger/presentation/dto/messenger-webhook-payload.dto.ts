import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

// --- Leaf DTOs (no nested references) ---

class MessengerSenderDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  id?: string;
}

class MessengerReferralDto {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  ref?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  type?: string;
}

class MessengerAttachmentPayloadDto {
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  url?: string;

  @IsOptional()
  @IsNumber()
  sticker_id?: number;
}

class MessengerAttachmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  type?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => MessengerAttachmentPayloadDto)
  payload?: MessengerAttachmentPayloadDto;
}

class MessengerOptinDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  payload?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  notification_messages_token?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  notification_messages_status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  topic?: string;

  @IsOptional()
  @IsString()
  frequency?: 'DAILY' | 'WEEKLY' | 'MONTHLY';

  @IsOptional()
  @IsString()
  @MaxLength(256)
  ref?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  title?: string;
}

class MessengerPostbackDto {
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  payload?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => MessengerReferralDto)
  referral?: MessengerReferralDto;
}

// --- Composite DTOs ---

class MessengerMessageDto {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  mid?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  text?: string;

  @IsOptional()
  @IsBoolean()
  is_echo?: boolean;

  @IsOptional()
  @IsNumber()
  sticker_id?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => MessengerAttachmentDto)
  attachments?: MessengerAttachmentDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => MessengerReferralDto)
  referral?: MessengerReferralDto;
}

// --- Event DTO ---

export class MessengerEventDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => MessengerSenderDto)
  sender?: MessengerSenderDto;

  @IsOptional()
  @IsNumber()
  timestamp?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => MessengerMessageDto)
  message?: MessengerMessageDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => MessengerPostbackDto)
  postback?: MessengerPostbackDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => MessengerReferralDto)
  referral?: MessengerReferralDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => MessengerOptinDto)
  optin?: MessengerOptinDto;
}

// --- Entry + Payload DTOs ---

class MessengerEntryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  id?: string;

  @IsOptional()
  @IsNumber()
  time?: number;

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => MessengerEventDto)
  messaging: MessengerEventDto[];
}

export class MessengerWebhookPayloadDto {
  @IsString()
  object: string;

  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => MessengerEntryDto)
  entry: MessengerEntryDto[];
}
