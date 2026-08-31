import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import type { ChatToolDailyUsageEntity } from '../entities/chat-tool-daily-usage.entity';
import { WriteToolBudgetCore } from './write-tool-budget-core.service';
import { WriteToolBudgetRepository } from './write-tool-budget.repository';
import { readWriteToolBudgetConfig } from './write-tool-budget-config';

export interface WriteToolBudgetMetricsSink {
  incWriteToolBudgetDenied?(
    tool: string,
    platform: string,
    reason: 'daily' | 'per_message',
  ): void;
}

export class PlatformWriteToolBudgetService {
  private readonly logger = new Logger(PlatformWriteToolBudgetService.name);
  private readonly core: WriteToolBudgetCore;
  private readonly platform: string;
  private readonly perMessageCapsMap: Record<string, number>;

  constructor(
    options: { platform: string },
    configService: ConfigService,
    toolDailyUsageRepo: Repository<ChatToolDailyUsageEntity>,
    metrics?: WriteToolBudgetMetricsSink,
  ) {
    this.platform = options.platform;
    const settings = readWriteToolBudgetConfig((k) =>
      configService.get<string>(k),
    );
    this.perMessageCapsMap = settings.perMessageCaps;
    this.core = new WriteToolBudgetCore(
      new WriteToolBudgetRepository(toolDailyUsageRepo, options.platform),
      settings,
      {
        onDenied: (tool, reason) =>
          metrics?.incWriteToolBudgetDenied?.(tool, this.platform, reason),
        logger: { warn: (m) => this.logger.warn(m) },
      },
    );
  }

  isEnabled(): boolean {
    return this.core.isEnabled();
  }

  perMessageCaps(): Record<string, number> {
    return this.perMessageCapsMap;
  }

  getPerMessageCap(toolName: string): number | undefined {
    return this.core.getPerMessageCap(toolName);
  }

  checkDailyAllowed(
    externalUserId: string,
    userId: number,
    toolName: string,
  ): Promise<boolean> {
    return this.core.checkDailyAllowed(externalUserId, userId, toolName);
  }

  consumeDaily(
    externalUserId: string,
    userId: number,
    toolName: string,
  ): Promise<boolean> {
    return this.core.consumeDaily(externalUserId, userId, toolName);
  }

  refundDaily(userId: number, toolName: string): Promise<void> {
    return this.core.refundDaily(userId, toolName);
  }
}
