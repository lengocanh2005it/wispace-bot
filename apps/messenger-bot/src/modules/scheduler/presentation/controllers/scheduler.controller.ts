import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';
import { InternalApiKeyGuard } from '@wispace/bot-common/guard';
import {
  createSessionSourceGetSessions,
  StudyReminderSyncService,
  StudyReminderWorkerService,
  type StudyReminderSyncResult,
} from '@wispace/study-reminder-shared';
import { StudySessionSourceService } from '@messenger/modules/study-reminder/application/services/study-session-source.service';
import { MessengerMappingService } from '@messenger/modules/messenger/application/services/messenger-mapping.service';
import { DopplerRuntimeSyncService } from '../../application/services/doppler-runtime-sync.service';
import type { DopplerWebhookPayload } from '../../domain/entities/doppler-runtime-sync.types';
import { ReportCronService } from '../../application/services/report-cron.service';
import { ReportSendRetryDispatchService } from '../../application/services/report-send-retry-dispatch.service';
import { PrivacyDataService } from '@wispace/database';

class SyncStudyCalendarBody {
  @IsNumber()
  @IsPositive()
  userId!: number;
}

class RelinkMappingBody {
  @IsString()
  psid!: string;

  @IsNumber()
  @IsPositive()
  userId!: number;

  @IsOptional()
  @IsBoolean()
  allowRelink?: boolean;
}

class SendReportsBody {
  @IsOptional()
  @IsString()
  psid?: string;

  @IsOptional()
  @IsBoolean()
  allowDuplicate?: boolean;
}

class PrivacyActionBody {
  @IsString()
  externalUserId!: string;
}

@Controller('messenger')
@UseGuards(InternalApiKeyGuard)
export class SchedulerController {
  constructor(
    private readonly reportCronService: ReportCronService,
    private readonly studyReminderSyncService: StudyReminderSyncService,
    private readonly studyReminderWorkerService: StudyReminderWorkerService,
    private readonly sessionSourceService: StudySessionSourceService,
    private readonly messengerMappingService: MessengerMappingService,
    private readonly reportSendRetryDispatchService: ReportSendRetryDispatchService,
    private readonly dopplerRuntimeSyncService: DopplerRuntimeSyncService,
    private readonly privacyService: PrivacyDataService,
  ) {}

  @Post('ops/doppler-sync')
  @HttpCode(202)
  dopplerRuntimeSync(@Body() body?: DopplerWebhookPayload) {
    return this.dopplerRuntimeSyncService.scheduleSync(body);
  }

  @Post('send-reports')
  @HttpCode(200)
  sendReports(@Body() body?: SendReportsBody) {
    return this.reportCronService.sendScheduledReports({
      forceSend: true,
      externalUserId: body?.psid?.trim(),
      allowDuplicate: body?.allowDuplicate === true,
    });
  }

  @Post('send-reports/retry-dispatch')
  @HttpCode(200)
  dispatchReportSendRetries() {
    return this.reportSendRetryDispatchService.dispatchDueReportRetries();
  }

  @Post('mapping/relink')
  @HttpCode(200)
  relinkMessengerMapping(@Body() body: RelinkMappingBody) {
    return this.messengerMappingService.relinkPsidToUserId({
      psid: body.psid,
      userId: body.userId,
      notifyUser: false,
      allowRelink: body.allowRelink === true,
    });
  }

  @Post('study-calendar/sync')
  @HttpCode(200)
  syncStudyCalendarAfterChange(@Body() body: SyncStudyCalendarBody) {
    return this.studyReminderSyncService
      .syncUpcomingSessions({
        userId: body.userId,
        // Authoritative calendar fetch before any stale-job cancellation.
        getSessions: createSessionSourceGetSessions(this.sessionSourceService),
      })
      .then((result) => this.toWireSyncResult(result));
  }

  @Post('sync-study-reminders')
  @HttpCode(200)
  syncStudyReminders() {
    return this.studyReminderSyncService
      .syncUpcomingSessions({
        // Authoritative calendar fetch before any stale-job cancellation.
        getSessions: createSessionSourceGetSessions(this.sessionSourceService),
      })
      .then((result) => this.toWireSyncResult(result));
  }

  @Post('send-study-reminders')
  @HttpCode(200)
  sendStudyReminders() {
    return this.studyReminderWorkerService.runSyncAndDispatch().then((r) => ({
      sync: r.sync ? this.toWireSyncResult(r.sync) : r.sync,
      dispatch: {
        ...r.dispatch,
        failures: r.dispatch.failures.map((f) => ({
          psid: f.externalUserId,
          error: f.error,
        })),
      },
    }));
  }

  @Post('study-reminder/evening-rollover')
  @HttpCode(200)
  runStudyReminderEveningRollover() {
    return this.studyReminderWorkerService.runEveningRollover().then((r) => ({
      deletedSent: r.deletedSent,
      sync: this.toWireSyncResult(r.sync),
    }));
  }

  @Post('privacy/unlink')
  @HttpCode(200)
  unlinkUser(@Body() body: PrivacyActionBody) {
    return this.privacyService.unlink('messenger', body.externalUserId);
  }

  @Post('privacy/delete')
  @HttpCode(200)
  deleteUser(@Body() body: PrivacyActionBody) {
    return this.privacyService.delete('messenger', body.externalUserId);
  }

  @Post('privacy/export')
  @HttpCode(200)
  exportUser(@Body() body: PrivacyActionBody) {
    return this.privacyService.export('messenger', body.externalUserId);
  }

  /**
   * Shared sync result shape uses platform-agnostic `externalUserId`;
   * the messenger ops wire exposes it as `psid`.
   */
  private toWireSyncResult(result: StudyReminderSyncResult) {
    return {
      ...result,
      failures:
        result.failures?.map((f) => ({
          psid: f.externalUserId,
          error: f.error,
        })) ?? [],
    };
  }
}
