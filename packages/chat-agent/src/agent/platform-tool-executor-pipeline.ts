import {
  detectPromptInjection,
  deriveAgentToolMap,
  getAgentToolDefinition,
  isAgentToolName,
  parseAndValidateToolArguments,
  sanitizeUntrustedTextForLlm,
  AGENT_TOOL_NAMES,
  type AgentToolCapability,
  type AgentToolMap,
  type AgentToolMetadata,
  type AgentToolName,
} from '@wispace/llm-agent';
import {
  errorMessage,
  maskExternalId,
  maskExternalIdInText,
} from '@wispace/bot-common/masking';
import { isAbortError } from '@wispace/bot-common/utils';
import {
  isWriteToolName,
  refundConsumedWriteToolBudget,
  runWriteToolBudgetGate,
  type WriteToolBudgetPort,
} from './write-tool-budget';
import type {
  CurrentPlatformIdentity,
  PlatformAgentToolContext,
} from './platform-agent.types';

export interface PlatformToolHandlerInput {
  args: Record<string, unknown>;
  canonicalArgs: string;
  ctx: PlatformAgentToolContext;
  signal?: AbortSignal;
}

export type PlatformToolHandler = (
  input: PlatformToolHandlerInput,
) => Promise<unknown>;

export type PlatformToolHandlerRegistry = AgentToolMap<PlatformToolHandler>;

const PLATFORM_TOOL_HANDLER_RESULT = Symbol('PLATFORM_TOOL_HANDLER_RESULT');

export interface PlatformToolHandlerResult {
  readonly [PLATFORM_TOOL_HANDLER_RESULT]: true;
  readonly value: unknown;
  readonly decoration?: unknown;
}

export function withPlatformToolDecoration(
  value: unknown,
  decoration: unknown,
): PlatformToolHandlerResult {
  return {
    [PLATFORM_TOOL_HANDLER_RESULT]: true,
    value,
    decoration,
  };
}

function isPlatformToolHandlerResult(
  value: unknown,
): value is PlatformToolHandlerResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<PlatformToolHandlerResult>)[
      PLATFORM_TOOL_HANDLER_RESULT
    ] === true
  );
}

export interface PlatformToolDecorationInput {
  toolName: AgentToolName;
  result: unknown;
  decoration?: unknown;
  ctx: PlatformAgentToolContext;
  signal?: AbortSignal;
}

export interface PlatformToolExecutorPipelineOptions {
  handlers: PlatformToolHandlerRegistry;
  getNotLinkedMessage: () => string;
  currentIdentityProvider?: (
    externalUserId: string,
  ) => Promise<CurrentPlatformIdentity | undefined>;
  policyDeniedInc?: (toolName: string, reason: string) => void;
  writeToolBudget?: WriteToolBudgetPort;
  writeToolPerMessageCaps?: Partial<Record<AgentToolName, number>>;
  writeToolBudgetDeniedInc?: (toolName: string, reason: 'per_message') => void;
  /** undefined defers the intent check to the platform handler. */
  checkExplicitIntent?: (
    toolName: AgentToolName,
    userText: string,
  ) => boolean | undefined;
  intentDeniedResult?: (toolName: AgentToolName) => unknown;
  decorateResult?: (input: PlatformToolDecorationInput) => void | Promise<void>;
  logger?: Pick<Console, 'warn'>;
}

export interface PlatformToolConformanceEntry {
  capability: AgentToolCapability;
  metadata: AgentToolMetadata;
}

export function assertPlatformToolHandlerRegistry(
  handlers: Partial<Record<AgentToolName, PlatformToolHandler>>,
): asserts handlers is PlatformToolHandlerRegistry {
  const missing = AGENT_TOOL_NAMES.filter(
    (name) => typeof handlers[name] !== 'function',
  );
  if (missing.length > 0) {
    throw new Error(
      `Platform tool handler registry is incomplete: ${missing.join(', ')}`,
    );
  }
}

function throwIfToolAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  }
}

export function defaultExplicitIntent(
  toolName: AgentToolName,
  userText: string,
): boolean | undefined {
  // This tool has a stricter selection/injection gate in its platform handler.
  if (toolName === 'precreate_next_exercise') return undefined;
  const text = userText.trim().toLowerCase();
  if (!text || detectPromptInjection(text).isInjection) return false;
  if (toolName === 'reschedule_study_session') {
    return (
      /(đổi|dời|chuyển|hoãn|reschedule|move|change)/i.test(text) &&
      /(lịch|buổi\s*học|giờ\s*học|schedule)/i.test(text)
    );
  }
  if (toolName === 'register_exam_report_notifications') {
    return /(đăng\s*ký|register).*(báo\s*cáo|report)|(báo\s*cáo|report).*(tự\s*động|automatic)/i.test(
      text,
    );
  }
  return false;
}

/** Shared ordered executor for every platform-owned tool registry. */
export class PlatformToolExecutorPipeline {
  private readonly handlers: PlatformToolHandlerRegistry;
  private readonly logger: Pick<Console, 'warn'>;

  constructor(private readonly options: PlatformToolExecutorPipelineOptions) {
    assertPlatformToolHandlerRegistry(options.handlers);
    this.handlers = options.handlers;
    this.logger = options.logger ?? console;
  }

  async execute(
    toolName: string,
    argsJson: string,
    ctx: PlatformAgentToolContext,
    signal?: AbortSignal,
  ): Promise<unknown> {
    throwIfToolAborted(signal);
    if (!isAgentToolName(toolName)) {
      return { error: `Unknown tool: ${toolName}` };
    }

    const parsed = parseAndValidateToolArguments(toolName, argsJson, {
      allowMissingRequired: true,
    });
    if (!parsed.ok) {
      this.options.policyDeniedInc?.(toolName, 'invalid_arguments');
      return { error: parsed.error };
    }

    const capability = getAgentToolDefinition(toolName)?.capability;
    if (!capability) {
      this.options.policyDeniedInc?.(toolName, 'missing_capability');
      return { error: 'Tool execution blocked by policy' };
    }

    if (capability.identity === 'linked_wispace_account') {
      const identity = await this.resolveCurrentIdentity(ctx, toolName, signal);
      if (!identity) {
        return {
          available: false,
          message: this.options.getNotLinkedMessage(),
        };
      }
      ctx.userId = identity.userId;
      ctx.mappingVersion = identity.mappingVersion;
      ctx.identityVerified = true;
    }

    if (ctx.userText !== undefined && capability.confirmation !== 'none') {
      const explicitIntent = (
        this.options.checkExplicitIntent ?? defaultExplicitIntent
      )(toolName, ctx.userText);
      if (explicitIntent === false) {
        this.options.policyDeniedInc?.(toolName, 'intent_unclear');
        return (
          this.options.intentDeniedResult?.(toolName) ?? {
            error: 'intent_unclear',
          }
        );
      }
    }

    if (
      isWriteToolName(toolName) &&
      this.options.writeToolBudget &&
      ctx.userId
    ) {
      const denial = await runWriteToolBudgetGate(toolName, ctx, {
        budget: this.options.writeToolBudget,
        perMessageCaps: this.options.writeToolPerMessageCaps,
        deniedInc: this.options.writeToolBudgetDeniedInc,
      });
      throwIfToolAborted(signal);
      if (denial) return denial;
    }

    try {
      throwIfToolAborted(signal);
      const handlerResult = await this.handlers[toolName]({
        args: parsed.args,
        canonicalArgs: parsed.canonicalArgs,
        ctx,
        signal,
      });
      const result = isPlatformToolHandlerResult(handlerResult)
        ? handlerResult.value
        : handlerResult;
      const decoration = isPlatformToolHandlerResult(handlerResult)
        ? handlerResult.decoration
        : undefined;

      await refundConsumedWriteToolBudget(
        ctx,
        this.options.writeToolBudget,
        result,
      );
      await this.options.decorateResult?.({
        toolName,
        result,
        decoration,
        ctx,
        signal,
      });
      return result;
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        throw error;
      }
      const safeError = this.safeErrorMessage(error, ctx.externalUserId);
      this.logger.warn(
        `Tool ${toolName} failed for externalUserId=${maskExternalId(
          ctx.externalUserId,
        )}: ${safeError}`,
      );
      return { error: safeError };
    }
  }

  private async resolveCurrentIdentity(
    ctx: PlatformAgentToolContext,
    toolName: AgentToolName,
    signal?: AbortSignal,
  ): Promise<CurrentPlatformIdentity | undefined> {
    ctx.identityVerified = false;
    ctx.userId = undefined;
    ctx.mappingVersion = undefined;
    const provider = this.options.currentIdentityProvider;
    if (typeof provider !== 'function') {
      this.options.policyDeniedInc?.(toolName, 'missing_identity_provider');
      return undefined;
    }
    try {
      const identity = await provider(ctx.externalUserId);
      throwIfToolAborted(signal);
      if (
        !identity ||
        !Number.isInteger(identity.userId) ||
        identity.userId <= 0 ||
        typeof identity.mappingVersion !== 'string' ||
        !identity.mappingVersion.trim()
      ) {
        this.options.policyDeniedInc?.(toolName, 'missing_mapping');
        return undefined;
      }
      return identity;
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        throw error;
      }
      const safeError = this.safeErrorMessage(error, ctx.externalUserId);
      this.logger.warn(
        `Current-mapping lookup failed for ${maskExternalId(
          ctx.externalUserId,
        )}: ${safeError}`,
      );
      this.options.policyDeniedInc?.(toolName, 'mapping_lookup_failed');
      return undefined;
    }
  }

  private safeErrorMessage(error: unknown, externalUserId: string): string {
    const sanitized = sanitizeUntrustedTextForLlm(errorMessage(error), {
      maxChars: 500,
      unsafePlaceholder: 'Tool execution failed',
    }).text;
    return maskExternalIdInText(sanitized, externalUserId);
  }
}

/** Capability/metadata projection used by conformance tests and diagnostics. */
export const PLATFORM_TOOL_CONFORMANCE_MATRIX =
  deriveAgentToolMap<PlatformToolConformanceEntry>((tool) => ({
    capability: tool.capability,
    metadata: tool.metadata,
  }));
