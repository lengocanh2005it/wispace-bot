import { Body, HttpCode, Post, Res } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class PrivacyExpectedMappingBody {
  @IsBoolean()
  exists!: boolean;

  @IsOptional()
  @IsNumber()
  userId?: number;

  @IsOptional()
  @IsString()
  mappingGeneration?: string;
}

export class PrivacyActionBody {
  @IsString()
  externalUserId!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => PrivacyExpectedMappingBody)
  expectedMapping?: PrivacyExpectedMappingBody;
}

export interface PlatformOpsHandlers {
  sendReports(body?: unknown): unknown;
  syncStudyReminders(): unknown;
  unlinkUser(
    externalUserId: string,
    expectedMapping?: PrivacyExpectedMappingBody,
  ): unknown;
  deleteUser(
    externalUserId: string,
    expectedMapping?: PrivacyExpectedMappingBody,
  ): unknown;
  exportUser(externalUserId: string): unknown;
  clearClarification(externalUserId: string): unknown;
}

export interface PrivacyResponseStatus {
  status?: 'complete' | 'incomplete';
  conflict?: boolean;
}

export interface PrivacyResponse {
  status(code: number): unknown;
}

export abstract class PlatformOpsController {
  protected constructor(protected readonly ops: PlatformOpsHandlers) {}

  @Post('send-reports')
  @HttpCode(200)
  sendReports(@Body() body?: unknown) {
    return this.ops.sendReports(body);
  }

  @Post('sync-study-reminders')
  @HttpCode(200)
  syncStudyReminders() {
    return this.ops.syncStudyReminders();
  }

  @Post('ops/clarification/clear')
  @HttpCode(204)
  async clearClarificationState(@Body() body: PrivacyActionBody) {
    await this.ops.clearClarification(body.externalUserId);
  }

  @Post('privacy/unlink')
  @HttpCode(200)
  async unlinkUser(
    @Body() body: PrivacyActionBody,
    @Res({ passthrough: true }) response?: PrivacyResponse,
  ) {
    const result = await this.ops.unlinkUser(
      body.externalUserId,
      body.expectedMapping,
    );
    setPrivacyResponseStatus(response, result);
    return result;
  }

  @Post('privacy/delete')
  @HttpCode(200)
  async deleteUser(
    @Body() body: PrivacyActionBody,
    @Res({ passthrough: true }) response?: PrivacyResponse,
  ) {
    const result = await this.ops.deleteUser(
      body.externalUserId,
      body.expectedMapping,
    );
    setPrivacyResponseStatus(response, result);
    return result;
  }

  @Post('privacy/export')
  @HttpCode(200)
  exportUser(@Body() body: PrivacyActionBody) {
    return this.ops.exportUser(body.externalUserId);
  }
}

export function setPrivacyResponseStatus(
  response: PrivacyResponse | undefined,
  result: unknown,
): void {
  if (!response || !result || typeof result !== 'object') return;
  const outcome = result as PrivacyResponseStatus;
  if (outcome.conflict) {
    response.status(409);
  } else if (outcome.status === 'incomplete') {
    response.status(202);
  }
}
