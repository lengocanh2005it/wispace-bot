import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlatformLlmUsageRecorderAdapter } from '@wispace/chat-metering';
import { WispaceGoalsService } from '@wispace/wispace-client';
import type { LlmProviderAdapter } from '@wispace/llm-agent';
import { PlatformStudentReportService } from './platform-student-report.service';

export interface CreatePlatformStudentReportServiceOptions {
  platform: string;
  promptDir: string;
}

/**
 * NestJS provider factory for `PlatformStudentReportService` — replaces the
 * near-identical `useFactory` blocks in the Discord and Zalo report modules
 * (differ only by platform string + prompts dir).
 */
export function createPlatformStudentReportServiceProvider(
  options: CreatePlatformStudentReportServiceOptions,
): Provider {
  return {
    provide: PlatformStudentReportService,
    useFactory: (
      configService: ConfigService,
      goalsService: WispaceGoalsService,
      usageRecorder: PlatformLlmUsageRecorderAdapter,
      adapter: LlmProviderAdapter,
    ) =>
      new PlatformStudentReportService(
        options.platform,
        configService,
        goalsService,
        usageRecorder,
        adapter,
        options.promptDir,
      ),
    inject: [
      ConfigService,
      WispaceGoalsService,
      PlatformLlmUsageRecorderAdapter,
      'LLM_PROVIDER_ADAPTER',
    ],
  };
}
