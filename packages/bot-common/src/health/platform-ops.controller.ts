import { Body, HttpCode, Post } from '@nestjs/common';
import { IsString } from 'class-validator';

export class PrivacyActionBody {
  @IsString()
  externalUserId!: string;
}

export interface PlatformOpsHandlers {
  sendReports(body?: unknown): unknown;
  syncStudyReminders(): unknown;
  unlinkUser(externalUserId: string): unknown;
  deleteUser(externalUserId: string): unknown;
  exportUser(externalUserId: string): unknown;
  clearClarification(externalUserId: string): unknown;
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
  unlinkUser(@Body() body: PrivacyActionBody) {
    return this.ops.unlinkUser(body.externalUserId);
  }

  @Post('privacy/delete')
  @HttpCode(200)
  deleteUser(@Body() body: PrivacyActionBody) {
    return this.ops.deleteUser(body.externalUserId);
  }

  @Post('privacy/export')
  @HttpCode(200)
  exportUser(@Body() body: PrivacyActionBody) {
    return this.ops.exportUser(body.externalUserId);
  }
}
