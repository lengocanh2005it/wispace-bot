import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  Registry,
  Counter,
  Histogram,
  collectDefaultMetrics,
} from 'prom-client';

export interface MetricsConfig {
  /** Prefix for metric names (e.g., 'messenger', 'discord', 'zalo') */
  prefix: string;
  /** Whether to collect default Node.js metrics */
  collectDefaults?: boolean;
}

@Injectable()
export class BotMetricsService implements OnModuleDestroy {
  private readonly logger = new Logger(BotMetricsService.name);
  readonly registry: Registry;
  private readonly prefix: string;

  private chatStepDuration: Histogram;
  private llmCallDuration: Histogram;
  private llmToolDuration: Histogram;
  private llmToolCalls: Counter;
  private llmRoundOutcome: Counter;
  private quotaDenied: Counter;
  private reminderDispatch: Counter;

  constructor(config: MetricsConfig) {
    this.prefix = config.prefix;
    this.registry = new Registry();

    if (config.collectDefaults !== false) {
      collectDefaultMetrics({ register: this.registry });
    }

    this.chatStepDuration = new Histogram({
      name: `${this.prefix}_chat_step_duration_seconds`,
      help: 'Duration of chat pipeline steps',
      labelNames: ['step', 'status'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
      registers: [this.registry],
    });

    this.llmCallDuration = new Histogram({
      name: `${this.prefix}_llm_call_duration_seconds`,
      help: 'Duration of LLM API calls',
      labelNames: ['feature', 'model', 'round', 'status'],
      buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60],
      registers: [this.registry],
    });

    this.llmToolDuration = new Histogram({
      name: `${this.prefix}_llm_tool_duration_seconds`,
      help: 'Duration of LLM tool executions',
      labelNames: ['tool_name', 'status'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20],
      registers: [this.registry],
    });

    this.llmToolCalls = new Counter({
      name: `${this.prefix}_llm_tool_calls_total`,
      help: 'Total LLM tool invocations',
      labelNames: ['tool_name', 'status'],
      registers: [this.registry],
    });

    this.llmRoundOutcome = new Counter({
      name: `${this.prefix}_llm_round_outcome_total`,
      help: 'LLM agent round outcomes',
      labelNames: ['feature', 'outcome'],
      registers: [this.registry],
    });

    this.quotaDenied = new Counter({
      name: `${this.prefix}_chat_quota_denied_total`,
      help: 'Chat quota denied events',
      labelNames: ['reason'],
      registers: [this.registry],
    });

    this.reminderDispatch = new Counter({
      name: `${this.prefix}_reminder_dispatch_total`,
      help: 'Study reminder dispatch outcomes',
      labelNames: ['status'],
      registers: [this.registry],
    });
  }

  async timeStep<T>(step: string, fn: () => Promise<T>): Promise<T> {
    const end = this.chatStepDuration.startTimer({ step });
    try {
      const result = await fn();
      end({ status: 'ok' });
      return result;
    } catch (error) {
      end({ status: 'error' });
      throw error;
    }
  }

  async timeLlmCall<T>(
    feature: string,
    model: string,
    round: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const end = this.llmCallDuration.startTimer({
      feature,
      model,
      round: String(round),
    });
    try {
      const result = await fn();
      end({ status: 'ok' });
      return result;
    } catch (error) {
      end({ status: 'error' });
      throw error;
    }
  }

  async timeLlmExecution<T>(feature: string, fn: () => Promise<T>): Promise<T> {
    const end = this.llmCallDuration.startTimer({
      feature,
      model: '',
      round: '0',
    });
    try {
      const result = await fn();
      end({ status: 'ok' });
      return result;
    } catch (error) {
      end({ status: 'error' });
      throw error;
    }
  }

  async timeTool<T>(toolName: string, fn: () => Promise<T>): Promise<T> {
    const end = this.llmToolDuration.startTimer({ tool_name: toolName });
    try {
      const result = await fn();
      this.llmToolCalls.inc({ tool_name: toolName, status: 'ok' });
      end({ status: 'ok' });
      return result;
    } catch (error) {
      this.llmToolCalls.inc({ tool_name: toolName, status: 'error' });
      end({ status: 'error' });
      throw error;
    }
  }

  incQuotaDenied(reason: string): void {
    this.quotaDenied.inc({ reason });
  }

  incReminderDispatch(status: string): void {
    this.reminderDispatch.inc({ status });
  }

  incRoundOutcome(feature: string, outcome: string): void {
    this.llmRoundOutcome.inc({ feature, outcome });
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  onModuleDestroy(): void {
    this.registry.clear();
  }
}
