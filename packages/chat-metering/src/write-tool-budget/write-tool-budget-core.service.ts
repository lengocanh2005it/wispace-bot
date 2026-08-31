import { todayInTimezone as todayUsageDate } from '@wispace/date-utils';
import { maskExternalId } from '@wispace/bot-common/masking';
import type {
  WriteToolBudgetRepositoryPort,
  WriteToolBudgetSettings,
} from './write-tool-budget.types';

export interface WriteToolBudgetCoreDeps {
  onDenied?: (toolName: string, reason: 'daily' | 'per_message') => void;
  logger?: { warn(message: string): void };
}

const NOOP: Required<WriteToolBudgetCoreDeps> = {
  onDenied: () => undefined,
  logger: { warn: () => undefined },
};

/**
 * Platform-agnostic daily budget engine for mutating LLM tools (#626).
 * Owns: enable flag, whitelist bypass, timezone day-key, deny metric.
 * Per-message caps are exposed for the caller to enforce in memory.
 */
export class WriteToolBudgetCore {
  private readonly deps: Required<WriteToolBudgetCoreDeps>;

  constructor(
    private readonly repository: WriteToolBudgetRepositoryPort,
    private readonly settings: WriteToolBudgetSettings,
    deps: WriteToolBudgetCoreDeps = {},
  ) {
    this.deps = { ...NOOP, ...deps };
  }

  isEnabled(): boolean {
    return this.settings.enabled;
  }

  getPerMessageCap(toolName: string): number | undefined {
    return this.settings.perMessageCaps[toolName];
  }

  async checkDailyAllowed(
    externalUserId: string,
    userId: number,
    toolName: string,
  ): Promise<boolean> {
    const cap = this.capFor(externalUserId, toolName);
    if (cap === undefined) return true;

    const count = await this.repository.getDailyCount(
      userId,
      todayUsageDate(this.settings.timezone),
      toolName,
    );
    if (count >= cap) {
      this.deny(externalUserId, toolName, count, cap);
      return false;
    }
    return true;
  }

  async consumeDaily(
    externalUserId: string,
    userId: number,
    toolName: string,
  ): Promise<boolean> {
    const cap = this.capFor(externalUserId, toolName);
    if (cap === undefined) return true;

    const result = await this.repository.tryConsumeDaily({
      externalUserId,
      userId,
      usageDate: todayUsageDate(this.settings.timezone),
      toolName,
      dailyCap: cap,
    });
    if (!result.ok) {
      this.deny(externalUserId, toolName, result.count, cap);
      return false;
    }
    return true;
  }

  async refundDaily(userId: number, toolName: string): Promise<void> {
    if (!this.settings.enabled) return;
    if (this.settings.dailyCaps[toolName] === undefined) return;
    await this.repository.refundDaily({
      userId,
      usageDate: todayUsageDate(this.settings.timezone),
      toolName,
    });
  }

  /** Effective daily cap, or undefined when enforcement should be skipped. */
  private capFor(externalUserId: string, toolName: string): number | undefined {
    if (!this.settings.enabled) return undefined;
    if (this.settings.whitelist.has(externalUserId)) return undefined;
    return this.settings.dailyCaps[toolName];
  }

  private deny(
    externalUserId: string,
    toolName: string,
    count: number,
    cap: number,
  ): void {
    this.deps.onDenied(toolName, 'daily');
    this.deps.logger.warn(
      `WRITE_TOOL_BUDGET_DENY tool=${toolName} reason=daily ` +
        `externalUserId=${maskExternalId(externalUserId)} used=${count} cap=${cap}`,
    );
  }
}
