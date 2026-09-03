import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import type { ChatHistoryMessage } from '@wispace/chat-history';
import { errorMessage } from '@wispace/bot-common/masking';
import { LlmAgentService } from '../agent.service';
import {
  CHAT_SYSTEM_PROMPT_CORE,
  composeChatSystemPrompt,
} from '../chat-system-prompt';
import { isAgentToolName, parseAndValidateToolArguments } from '../agent.tools';
import {
  buildClarificationCancelledMessage,
  buildClarificationMessage,
  buildClarificationUnavailableMessage,
  buildFinalOutputBlockedMessage,
  buildGroundingBlockedMessage,
  buildPrecreateExerciseUnavailableMessage,
  buildPromptInjectionBlockedMessage,
  buildToolCallCapMessage,
  buildWispaceScopeRedirectMessage,
  CHAT_FAILURE_FALLBACK_MESSAGE,
} from '../messages';
import { NOOP_METRICS_PORT } from '../ports';
import type {
  LlmExecutionPort,
  LlmSafetyEventPort,
  LlmUsageRecorderPort,
  ToolExecutorPort,
} from '../ports';
import type { LlmProviderAdapter } from '../provider/llm-provider.adapter';
import type {
  LlmMessage,
  LlmToolChatRequest,
  LlmToolChatResponse,
} from '../provider/types';
import type { LlmAgentReply } from '../types';

/**
 * Deterministic offline orchestration regression harness for `LlmAgentService`.
 *
 * This is NOT a live-model evaluation: the LLM is replaced by a frozen
 * scripted adapter, so no provider/API call ever happens. It proves the
 * agent loop honors a fixture's expected orchestration — tool order, the
 * exact serialized tool arguments handed to the executor, request contracts
 * (system prompt, user message, tool definitions, tool choice), plan
 * consumption, leak guards, and the no-fabrication grounding guard.
 * Live model/tool-selection behavior belongs in a separate (manual or
 * nightly) eval lane — out of scope for CI.
 *
 * Fixtures (JSON, spec-style) declare the *expected* loop behavior for a
 * scenario: which tools are called in which order, what tool results feed
 * back into the loop, and what the final reply should look like.
 *
 * Fixtures pin the *real* chat prompts: `coreHash` is the sha256 of the
 * `CHAT_SYSTEM_PROMPT_CORE` value the runtime actually sends (LF-normalized),
 * and overlay files are referenced by path + sha256 — so any prompt change
 * fails the eval until the fixtures are re-validated (see AGENTS.md testing
 * notes).
 */

/**
 * Resolves the repo root by walking up until a `turbo.json` marker is found.
 * Jest runs with `rootDir: src` and can present `__dirname`-relative module
 * paths, so a fixed depth (`../../..`) is not reliable — the marker walk is.
 */
function resolveRepoRoot(): string {
  let dir = __dirname;
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(dir, 'turbo.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'eval: could not locate the repo root (no turbo.json found walking up)',
  );
}

const REPO_ROOT = resolveRepoRoot();

const EVAL_METADATA = {
  provider: 'eval',
  model: 'eval-model',
  responseId: 'eval-response',
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
} as const;

export interface EvalScriptedToolCall {
  /** Tool name — must exist in AGENT_TOOLS. */
  name: string;
  /** Tool arguments, validated against the tool's JSON schema. */
  args?: Record<string, unknown>;
  /** Value returned by the fake tool executor (JSON-serialized by the loop). */
  result?: unknown;
  /** When set, the fake tool executor throws this error instead. */
  fail?: string;
}

export interface EvalScriptRound {
  /**
   * Scripted parallel tool calls for this round.
   */
  toolCalls?: EvalScriptedToolCall[];
  /**
   * Assistant text accompanying the tool calls — the model's plan line for
   * multi-intent requests ("Mình sẽ kiểm tra lịch rồi tạo bài tập mới nhé.").
   * Must not be combined with `text`.
   */
  content?: string;
  /** Scripted final LLM text — must not be combined with toolCalls. */
  text?: string;
}

export interface EvalRequestContract {
  /**
   * 0-based LLM round index this contract applies to. Omitted = the contract
   * applies to every provider request the loop makes.
   */
  round?: number;
  /** Every fragment must appear in the system message content. */
  systemPromptContains?: string[];
  /** Every fragment must appear in the latest user message content. */
  userMessageContains?: string[];
  /** Every named tool's JSON schema must be present in the request. */
  toolsInclude?: string[];
  /**
   * Exact `toolChoice` mode the request must carry; null = the request must
   * not set `toolChoice` at all.
   */
  toolChoice?: 'auto' | 'none' | 'required' | null;
}

export interface EvalExpectation {
  /** Exact ordered list of tool names invoked across all rounds. */
  toolSequence?: string[];
  /**
   * Number of scripted tool calls left unconsumed when the loop finished
   * (default 0). Scenarios that intentionally skip execution (call-cap,
   * duplicate side effects) declare the leftover count.
   */
  planRemainder?: number;
  /** Every fragment must appear in the reply text. */
  replyTextContains?: string[];
  /** Fabrication guard — none of these may appear in the reply text. */
  replyTextNotContains?: string[];
  /**
   * Leak guard — none of these may appear in any tool-result message sent
   * to the model across ANY round (e.g. raw error text that must be
   * sanitized before it reaches the model context, #161).
   */
  toolResultsNotContain?: string[];
  /**
   * State-based leak guard (#505): none of these may appear in ANY part of
   * any recorded provider request (system prompt, user text, tool messages,
   * tool definitions). Unlike reply assertions, this checks what the system
   * actually sends the model — a scripted reply cannot satisfy it.
   */
  requestNotContains?: string[];
  exhausted?: boolean;
  /** null = must be absent; string = must match exactly. */
  toolSummary?: string | null;
  /** Expected grounding-warning count (default 0). */
  groundingWarnings?: number;
  /** Expected neutralized-injection event count — tool result or replayed history (#629, default 0). */
  injectionEvents?: number;
  /** Request-contract assertions run against the recorded provider requests. */
  requestContracts?: EvalRequestContract[];
  /**
   * #721 — when true, the harness fails unless a `compaction:*` call was
   * observed going through the fake `LlmExecutionPort`. Routing-only proof
   * that history compaction honors the shared execution path (#703).
   */
  compactionViaExecutionPort?: boolean;
}

export interface EvalPromptFile {
  /** Path relative to the repo root — must point at a real prompt file. */
  path: string;
  /** sha256 hex of the file's LF-normalized content. */
  hash: string;
}

export interface EvalFixture {
  /** kebab-case id, shown in test output. */
  name: string;
  description?: string;
  /**
   * #635 battery tier. `must-block` (default) fixtures are never allowed to
   * fail; `adversarial` probes tolerate a configured bypass rate so a newly
   * discovered bypass can land as a failing fixture before its fix.
   */
  tier: 'must-block' | 'adversarial';
  /**
   * sha256 (hex) of the LF-normalized `CHAT_SYSTEM_PROMPT_CORE` value — the
   * exact core text production composes. A prompt edit fails the eval until
   * the hash is re-validated and updated deliberately (#646).
   */
  coreHash: string;
  /**
   * Overlay prompt files this scenario runs against (platform-specific rules
   * — e.g. `apps/discord-bot/src/shared/prompts/discord-chat.system.txt`),
   * LF-normalized and hash-pinned. The full system prompt is composed by the
   * shared `composeChatSystemPrompt` (core + overlays + suffix) — the same
   * function `PlatformAgentService.buildSystemPrompt` calls.
   */
  promptFiles: EvalPromptFile[];
  /** Optional suffix appended to the system prompt (e.g. linkage note). */
  systemPromptSuffix?: string;
  userText: string;
  /** Must be a fake `eval-...` id — repo log-redaction policy applies. */
  externalUserId: string;
  userId?: number;
  history?: ChatHistoryMessage[];
  /** One entry per LLM round (in order). Empty = the LLM is never called. */
  script: EvalScriptRound[];
  expected: EvalExpectation;
  /**
   * #721 — opts this fixture into history compaction: the harness enables
   * `compactionEnabled` with the given input-token budget (compaction only
   * cares over/under budget, so small test budgets are representative).
   * The compaction summary is served canned by the scripted adapter and never
   * consumes a script round.
   */
  compaction?: {
    enabled: boolean;
    maxInputTokens?: number;
  };
  /**
   * When true, the fixture may script tool calls with names not in AGENT_TOOLS.
   * Used to test the agent loop's behavior when the LLM attempts unknown tools.
   */
  allowUnknown?: boolean;
  /**
   * #505: default true. When false, `ScriptedAdapter.isConfigured()` returns
   * false so the loop's adapter-not-configured fallback path is exercised.
   */
  adapterConfigured?: boolean;
}

export interface EvalFixtureResult {
  name: string;
  ok: boolean;
  failures: string[];
  summary: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateToolArgs(
  toolName: string,
  args: Record<string, unknown> | undefined,
  errors: string[],
): void {
  const result = parseAndValidateToolArguments(
    toolName,
    JSON.stringify(args ?? {}),
  );
  if (!result.ok) {
    const missing = result.error.match(/^Missing tool argument: (.+)$/);
    errors.push(
      missing
        ? `tool "${toolName}" is missing required arg "${missing[1]}"`
        : `tool "${toolName}": ${result.error}`,
    );
  }
}

function validateRound(
  round: unknown,
  index: number,
  errors: string[],
  allowUnknown = false,
): void {
  if (!isRecord(round)) {
    errors.push(`script[${index}] must be an object`);
    return;
  }
  const hasToolCalls = Array.isArray(round.toolCalls);
  const hasText = typeof round.text === 'string' && round.text.length > 0;
  if (hasToolCalls && hasText) {
    errors.push(`script[${index}] must not combine toolCalls and text`);
  }
  if (!hasToolCalls && !hasText) {
    errors.push(`script[${index}] must declare toolCalls or text`);
    return;
  }
  if (round.content !== undefined) {
    if (!hasToolCalls) {
      errors.push(`script[${index}].content (plan line) requires toolCalls`);
    } else if (
      typeof round.content !== 'string' ||
      round.content.length === 0
    ) {
      errors.push(`script[${index}].content must be a non-empty string`);
    }
  }
  if (hasText) return;
  const toolCalls = round.toolCalls as unknown[];
  if (toolCalls.length === 0) {
    errors.push(`script[${index}].toolCalls must not be empty`);
    return;
  }
  for (const [j, call] of toolCalls.entries()) {
    if (!isRecord(call) || typeof call.name !== 'string') {
      errors.push(`script[${index}].toolCalls[${j}] must declare a name`);
      continue;
    }
    if (!isAgentToolName(call.name)) {
      if (!allowUnknown) {
        errors.push(
          `script[${index}].toolCalls[${j}].name "${call.name}" is not in AGENT_TOOLS`,
        );
      }
      // Skip args validation for unknown tools — no schema available.
    } else {
      if (call.args !== undefined && !isRecord(call.args)) {
        errors.push(`script[${index}].toolCalls[${j}].args must be an object`);
      } else {
        validateToolArgs(call.name, call.args, errors);
      }
    }
    if (call.fail !== undefined && typeof call.fail !== 'string') {
      errors.push(`script[${index}].toolCalls[${j}].fail must be a string`);
    }
  }
}

export function parseFixture(
  raw: unknown,
): { fixture: EvalFixture } | { errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    return { errors: ['fixture root must be an object'] };
  }

  const name = raw.name;
  if (typeof name !== 'string' || !/^[a-z0-9-]+$/.test(name)) {
    errors.push('name must be a kebab-case string');
  }
  if (raw.description !== undefined && typeof raw.description !== 'string') {
    errors.push('description must be a string');
  }
  if (
    raw.tier !== undefined &&
    !['must-block', 'adversarial'].includes(String(raw.tier))
  ) {
    errors.push('tier must be "must-block" or "adversarial" (#635)');
  }
  const promptFiles = raw.promptFiles;
  if (!Array.isArray(promptFiles) || promptFiles.length === 0) {
    errors.push('promptFiles must be a non-empty array of { path, hash }');
  } else {
    for (const [i, file] of promptFiles.entries()) {
      if (
        !isRecord(file) ||
        typeof file.path !== 'string' ||
        file.path.length === 0
      ) {
        errors.push(`promptFiles[${i}].path must be a non-empty string`);
      }
      if (
        !isRecord(file) ||
        typeof file.hash !== 'string' ||
        !/^[0-9a-f]{64}$/i.test(file.hash)
      ) {
        errors.push(
          `promptFiles[${i}].hash must be a sha256 hex string (64 chars)`,
        );
      }
    }
  }
  if (
    typeof raw.coreHash !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(raw.coreHash)
  ) {
    errors.push(
      'coreHash must be a sha256 hex string of the LF-normalized CHAT_SYSTEM_PROMPT_CORE value (#646)',
    );
  }
  if (
    raw.systemPromptSuffix !== undefined &&
    typeof raw.systemPromptSuffix !== 'string'
  ) {
    errors.push('systemPromptSuffix must be a string');
  }
  if (typeof raw.userText !== 'string' || raw.userText.trim().length === 0) {
    errors.push('userText is required');
  }
  const externalUserId = raw.externalUserId;
  if (typeof externalUserId !== 'string' || !/^eval-/.test(externalUserId)) {
    errors.push('externalUserId must be a fake "eval-..." id (privacy guard)');
  }
  if (
    raw.userId !== undefined &&
    (typeof raw.userId !== 'number' ||
      !Number.isInteger(raw.userId) ||
      raw.userId <= 0)
  ) {
    errors.push('userId must be a positive integer');
  }
  if (raw.history !== undefined) {
    if (!Array.isArray(raw.history)) {
      errors.push('history must be an array');
    } else {
      for (const [i, entry] of raw.history.entries()) {
        if (
          !isRecord(entry) ||
          !['user', 'assistant', 'tool_summary'].includes(String(entry.role)) ||
          typeof entry.content !== 'string'
        ) {
          errors.push(
            `history[${i}] must be { role: user|assistant|tool_summary, content: string }`,
          );
        }
      }
    }
  }
  if (raw.allowUnknown !== undefined && typeof raw.allowUnknown !== 'boolean') {
    errors.push('allowUnknown must be a boolean');
  }
  if (raw.compaction !== undefined) {
    if (
      !isRecord(raw.compaction) ||
      typeof raw.compaction.enabled !== 'boolean' ||
      (raw.compaction.maxInputTokens !== undefined &&
        (typeof raw.compaction.maxInputTokens !== 'number' ||
          !Number.isInteger(raw.compaction.maxInputTokens) ||
          raw.compaction.maxInputTokens <= 0))
    ) {
      errors.push(
        'compaction must be { enabled: boolean, maxInputTokens?: positive integer } (#721)',
      );
    }
  }
  if (
    raw.adapterConfigured !== undefined &&
    typeof raw.adapterConfigured !== 'boolean'
  ) {
    errors.push('adapterConfigured must be a boolean');
  }
  if (!Array.isArray(raw.script)) {
    errors.push('script must be an array of rounds');
  } else if (raw.script.length === 0) {
    // Empty script = the LLM is never called (e.g. injection/off-topic early
    // returns). The runner fails loudly if the adapter is invoked anyway.
  } else {
    const allowUnknown = raw.allowUnknown === true;
    for (const [i, round] of raw.script.entries()) {
      validateRound(round, i, errors, allowUnknown);
    }
  }
  if (!isRecord(raw.expected)) {
    errors.push('expected must be an object');
  } else {
    const expected = raw.expected;
    if (expected.toolSequence !== undefined) {
      if (
        !Array.isArray(expected.toolSequence) ||
        expected.toolSequence.some(
          (t) => typeof t !== 'string' || !isAgentToolName(t),
        )
      ) {
        errors.push(
          'expected.toolSequence must be an array of AGENT_TOOLS names',
        );
      }
    }
    if (expected.replyTextContains !== undefined) {
      if (
        !Array.isArray(expected.replyTextContains) ||
        expected.replyTextContains.some((t) => typeof t !== 'string')
      ) {
        errors.push('expected.replyTextContains must be an array of strings');
      }
    }
    if (expected.replyTextNotContains !== undefined) {
      if (
        !Array.isArray(expected.replyTextNotContains) ||
        expected.replyTextNotContains.some((t) => typeof t !== 'string')
      ) {
        errors.push(
          'expected.replyTextNotContains must be an array of strings',
        );
      }
    }
    if (expected.toolResultsNotContain !== undefined) {
      if (
        !Array.isArray(expected.toolResultsNotContain) ||
        expected.toolResultsNotContain.some((t) => typeof t !== 'string')
      ) {
        errors.push(
          'expected.toolResultsNotContain must be an array of strings',
        );
      }
    }
    if (expected.requestNotContains !== undefined) {
      if (
        !Array.isArray(expected.requestNotContains) ||
        expected.requestNotContains.some((t) => typeof t !== 'string')
      ) {
        errors.push('expected.requestNotContains must be an array of strings');
      }
    }
    if (
      expected.exhausted !== undefined &&
      typeof expected.exhausted !== 'boolean'
    ) {
      errors.push('expected.exhausted must be a boolean');
    }
    if (
      expected.toolSummary !== undefined &&
      expected.toolSummary !== null &&
      typeof expected.toolSummary !== 'string'
    ) {
      errors.push('expected.toolSummary must be a string or null');
    }
    if (
      expected.groundingWarnings !== undefined &&
      (typeof expected.groundingWarnings !== 'number' ||
        !Number.isInteger(expected.groundingWarnings) ||
        expected.groundingWarnings < 0)
    ) {
      errors.push('expected.groundingWarnings must be a non-negative integer');
    }
    if (
      expected.injectionEvents !== undefined &&
      (typeof expected.injectionEvents !== 'number' ||
        !Number.isInteger(expected.injectionEvents) ||
        expected.injectionEvents < 0)
    ) {
      errors.push('expected.injectionEvents must be a non-negative integer');
    }
    if (
      expected.planRemainder !== undefined &&
      (typeof expected.planRemainder !== 'number' ||
        !Number.isInteger(expected.planRemainder) ||
        expected.planRemainder < 0)
    ) {
      errors.push('expected.planRemainder must be a non-negative integer');
    }
    if (
      expected.compactionViaExecutionPort !== undefined &&
      typeof expected.compactionViaExecutionPort !== 'boolean'
    ) {
      errors.push('expected.compactionViaExecutionPort must be a boolean');
    }
    if (expected.requestContracts !== undefined) {
      if (!Array.isArray(expected.requestContracts)) {
        errors.push('expected.requestContracts must be an array');
      } else {
        for (const [i, contract] of expected.requestContracts.entries()) {
          if (!isRecord(contract)) {
            errors.push(`expected.requestContracts[${i}] must be an object`);
            continue;
          }
          if (
            contract.round !== undefined &&
            (typeof contract.round !== 'number' ||
              !Number.isInteger(contract.round) ||
              contract.round < 0)
          ) {
            errors.push(
              `expected.requestContracts[${i}].round must be a non-negative integer`,
            );
          }
          for (const field of [
            'systemPromptContains',
            'userMessageContains',
          ] as const) {
            const value = contract[field];
            if (
              value !== undefined &&
              (!Array.isArray(value) ||
                value.some((t) => typeof t !== 'string'))
            ) {
              errors.push(
                `expected.requestContracts[${i}].${field} must be an array of strings`,
              );
            }
          }
          if (contract.toolsInclude !== undefined) {
            if (
              !Array.isArray(contract.toolsInclude) ||
              contract.toolsInclude.some(
                (t) => typeof t !== 'string' || !isAgentToolName(t),
              )
            ) {
              errors.push(
                `expected.requestContracts[${i}].toolsInclude must be an array of AGENT_TOOLS names`,
              );
            }
          }
          if (
            contract.toolChoice !== undefined &&
            contract.toolChoice !== null &&
            (typeof contract.toolChoice !== 'string' ||
              !['auto', 'none', 'required'].includes(contract.toolChoice))
          ) {
            errors.push(
              `expected.requestContracts[${i}].toolChoice must be auto|none|required|null`,
            );
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    return { errors };
  }

  return {
    fixture: {
      name: String(name),
      description:
        typeof raw.description === 'string' ? raw.description : undefined,
      tier:
        raw.tier === 'adversarial'
          ? ('adversarial' as const)
          : ('must-block' as const),
      coreHash: String(raw.coreHash).toLowerCase(),
      promptFiles: (raw.promptFiles as EvalPromptFile[]).map((file) => ({
        path: String(file.path),
        hash: String(file.hash).toLowerCase(),
      })),
      systemPromptSuffix:
        typeof raw.systemPromptSuffix === 'string'
          ? raw.systemPromptSuffix
          : undefined,
      userText: String(raw.userText),
      externalUserId: String(externalUserId),
      userId: typeof raw.userId === 'number' ? raw.userId : undefined,
      history: Array.isArray(raw.history)
        ? (raw.history as ChatHistoryMessage[])
        : undefined,
      script: raw.script as EvalScriptRound[],
      expected: raw.expected as EvalExpectation,
      compaction: isRecord(raw.compaction)
        ? (raw.compaction as EvalFixture['compaction'])
        : undefined,
      adapterConfigured: raw.adapterConfigured === false ? false : true,
    },
  };
}

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function resolvePromptPath(promptPath: string): string {
  return resolve(REPO_ROOT, promptPath);
}

export type PromptLoadResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

/**
 * Reads one prompt file and verifies its LF-normalized sha256. Line endings
 * are normalized (`\r\n` → `\n`) before hashing so the fixture hash matches
 * regardless of whether the checkout uses CRLF (Windows) or LF (CI).
 */
export function loadPrompt(path: string, hash: string): PromptLoadResult {
  const resolved = resolvePromptPath(path);
  const relativePath = relative(REPO_ROOT, resolved);
  if (relativePath.startsWith('..') || relativePath.startsWith('.')) {
    return {
      ok: false,
      error: `promptPath "${path}" escapes the repo root`,
    };
  }
  let raw: string;
  try {
    raw = readFileSync(resolved, 'utf8');
  } catch {
    return { ok: false, error: `prompt file not found: ${path}` };
  }
  const content = raw.replace(/\r\n/g, '\n');
  const actual = sha256Hex(content);
  if (actual !== hash.toLowerCase()) {
    return {
      ok: false,
      error: [
        `prompt hash mismatch for ${path}`,
        `  fixture expects ${hash}`,
        `  actual is      ${actual}`,
        'The prompt changed — re-validate the fixture expected behavior,',
        'then update the hash (and the script) deliberately.',
      ].join('\n'),
    };
  }
  return { ok: true, content };
}

/**
 * Loads the overlay prompt files a fixture depends on. The full system
 * prompt (core + overlays + suffix) is composed by the shared
 * `composeChatSystemPrompt` — the same function the runtime uses (#646).
 */
export function loadPromptFiles(
  promptFiles: EvalPromptFile[],
): PromptLoadResult {
  const parts: string[] = [];
  for (const file of promptFiles) {
    const loaded = loadPrompt(file.path, file.hash);
    if (!loaded.ok) {
      return loaded;
    }
    parts.push(loaded.content);
  }
  return { ok: true, content: parts.join('\n\n') };
}

/**
 * Canned compaction summary for `compaction:*` calls (#721). Fixed benign
 * text by design: it must survive the output safety check and the
 * fact-stripping pass (no scores, dates, numbers, identity details), or the
 * harness would fail on machinery instead of the scenario. The compaction
 * answer is harness machinery, never scenario content.
 */
const COMPACTION_CANNED_SUMMARY = 'User discussed study plans and preferences.';

/** CorrelationIds of the form `compaction:<externalUserId>`. */
function isCompactionCorrelationId(correlationId: string | undefined): boolean {
  return correlationId?.startsWith('compaction:') === true;
}

/**
 * Frozen LLM adapter: returns the fixture's scripted responses in round
 * order. Fails loudly when the loop asks for more responses than scripted —
 * an early return (injection/off-topic) or an unexpected extra round shows
 * up as an adapter-call-count mismatch. Every provider request is retained
 * (`allRequests`) so leak/plan/contract assertions run across ALL rounds,
 * not just the last one.
 *
 * Compaction calls (`correlationId: compaction:*`, #721) are answered with
 * the canned summary WITHOUT consuming a script round: compaction is
 * pre-loop history prep, not a tool round, so `callCount` only tracks the
 * scripted rounds the `script.length` assertion counts.
 */
export class ScriptedAdapter implements LlmProviderAdapter {
  callCount = 0;

  /** Every provider request made by the loop, in round order. */
  readonly allRequests: LlmToolChatRequest[] = [];

  /** The messages array of the most recent `chatWithTools` call. */
  get lastRequestMessages(): LlmMessage[] {
    return this.allRequests[this.allRequests.length - 1]?.messages ?? [];
  }

  constructor(
    private readonly script: EvalScriptRound[],
    private readonly configured = true,
  ) {}

  readonly providerName = 'eval';

  isConfigured(): boolean {
    return this.configured;
  }

  getDefaultModel(): string {
    return 'eval-model';
  }

  chatWithTools(request: LlmToolChatRequest): Promise<LlmToolChatResponse> {
    // Kept visible to leak/plan/contract assertions on purpose: the
    // compaction prompt carries the full dropped history, so it is the most
    // leak-sensitive request. It is always allRequests[0] (pre-loop), so a
    // future round-indexed contract on a compaction fixture must account
    // for that offset.
    this.allRequests.push(request);
    if (isCompactionCorrelationId(request.correlationId)) {
      return Promise.resolve({
        message: { role: 'assistant', content: COMPACTION_CANNED_SUMMARY },
        content: COMPACTION_CANNED_SUMMARY,
        metadata: EVAL_METADATA,
      });
    }
    const round = this.script[this.callCount];
    this.callCount += 1;
    if (!round) {
      return Promise.reject(
        new Error(
          'eval: adapter called more times than the fixture script declares',
        ),
      );
    }
    if (round.text !== undefined) {
      return Promise.resolve({
        message: { role: 'assistant', content: round.text },
        content: round.text,
        metadata: EVAL_METADATA,
      });
    }
    const toolCalls = (round.toolCalls ?? []).map((call, i) => ({
      id: `eval-call-${this.callCount - 1}-${i}`,
      name: call.name,
      arguments: JSON.stringify(call.args ?? {}),
    }));
    return Promise.resolve({
      message: {
        role: 'assistant',
        content: round.content,
        toolCalls,
      },
      content: undefined,
      metadata: EVAL_METADATA,
    });
  }

  generateJson(): Promise<never> {
    return Promise.reject(
      new Error('eval: generateJson is not part of the agent loop'),
    );
  }

  chatStream(): AsyncIterable<never> {
    // The agent loop never streams — the final text is emitted as a single delta.
    throw new Error('eval: chatStream is not part of the agent loop');
  }

  isRetryableError(): boolean {
    return false;
  }

  isRateLimitError(): boolean {
    return false;
  }

  normalizeError() {
    return {
      provider: 'eval' as const,
      retryable: false,
      reason: 'unknown' as const,
    };
  }
}

/**
 * Fake tool executor: serves the scripted tool results in round order and
 * records every tool actually invoked — name, serialized args (deep-compared
 * against the scripted args), and any attempt that did not match the script.
 * An unexpected tool attempt or an args mismatch is an assertion failure,
 * and any scripted tool call left unconsumed (`remainingPlanCount`) is
 * reported by the harness.
 */
export class ScriptedToolExecutor {
  readonly actualTools: string[] = [];
  readonly unexpectedAttempts: string[] = [];
  readonly argsMismatches: string[] = [];
  private readonly plan: EvalScriptedToolCall[];

  constructor(script: EvalScriptRound[]) {
    this.plan = script.flatMap((round) => round.toolCalls ?? []);
  }

  get remainingPlanCount(): number {
    return this.plan.length;
  }

  readonly execute: ToolExecutorPort<Record<string, never>>['execute'] = (
    toolName,
    argsJson,
  ) => {
    const expected = this.plan.shift();
    if (!expected || expected.name !== toolName) {
      this.unexpectedAttempts.push(
        `unexpected tool "${toolName}" (scripted next: ${expected?.name ?? 'none'})`,
      );
      return Promise.reject(
        new Error(
          `eval: unexpected tool "${toolName}" (scripted next: ${expected?.name ?? 'none'})`,
        ),
      );
    }
    this.actualTools.push(toolName);
    let actualArgs: Record<string, unknown>;
    try {
      actualArgs = JSON.parse(argsJson || '{}') as Record<string, unknown>;
    } catch {
      actualArgs = { __unparsed: argsJson };
    }
    const scriptedArgs = expected.args ?? {};
    if (
      JSON.stringify(sortRecord(actualArgs)) !==
      JSON.stringify(sortRecord(scriptedArgs))
    ) {
      this.argsMismatches.push(
        `tool "${toolName}" args mismatch: scripted ${JSON.stringify(scriptedArgs)} got ${argsJson}`,
      );
    }
    if (expected.fail !== undefined) {
      return Promise.reject(new Error(expected.fail));
    }
    return Promise.resolve(expected.result);
  };
}

/** Recursively sorts object keys so arg comparison is key-order independent. */
function sortRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [
        key,
        isRecord(entry) ? sortRecord(entry) : entry,
      ]),
  );
}

/**
 * Token map for {{token}} placeholders in reply-text expectations (#505).
 * Built from the shared `messages.ts` builders so canned-reply assertions
 * cannot drift from production copy — one source, no inlined fragments.
 */
const REPLY_TOKENS: Record<string, string> = {
  scope_redirect: buildWispaceScopeRedirectMessage(),
  prompt_injection_blocked: buildPromptInjectionBlockedMessage(),
  grounding_blocked: buildGroundingBlockedMessage(),
  clarification: buildClarificationMessage(),
  clarification_cancelled: buildClarificationCancelledMessage(),
  clarification_unavailable: buildClarificationUnavailableMessage(),
  precreate_unavailable: buildPrecreateExerciseUnavailableMessage(),
  tool_call_cap: buildToolCallCapMessage(),
  final_output_blocked: buildFinalOutputBlockedMessage(),
  chat_failure_fallback: CHAT_FAILURE_FALLBACK_MESSAGE,
};

/**
 * Resolves {{token}} placeholders in reply-text expectation fragments.
 * Unknown tokens are pushed as fixture failures (typo protection) and the
 * fragment is dropped from matching.
 */
function resolveReplyFragments(
  fragments: string[],
  failures: string[],
): string[] {
  return fragments
    .map((fragment) => {
      const token = /^\{\{([a-z_]+)\}\}$/.exec(fragment);
      if (!token) return fragment;
      const resolved = REPLY_TOKENS[token[1]];
      if (resolved === undefined) {
        failures.push(
          `unknown placeholder "{{${token[1]}}}" — expected one of: ${Object.keys(REPLY_TOKENS).join(', ')}`,
        );
        return undefined;
      }
      return resolved;
    })
    .filter((fragment): fragment is string => fragment !== undefined);
}

/**
 * Runs a single fixture end-to-end and returns per-assertion results.
 */
export async function runEvalFixture(
  rawFixture: unknown,
): Promise<EvalFixtureResult> {
  const parsed = parseFixture(rawFixture);
  if ('errors' in parsed) {
    return {
      name: 'unknown',
      ok: false,
      failures: parsed.errors.map((error) => `fixture invalid: ${error}`),
      summary: 'fixture invalid',
    };
  }
  const fixture = parsed.fixture;

  // The core is composed from the imported runtime constant — the exact text
  // `PlatformAgentService.buildSystemPrompt` sends — and its hash is pinned
  // per fixture so prompt edits fail the eval until re-validated (#646).
  const actualCoreHash = sha256Hex(
    CHAT_SYSTEM_PROMPT_CORE.replace(/\r\n/g, '\n'),
  );
  if (actualCoreHash !== fixture.coreHash) {
    return {
      name: fixture.name,
      ok: false,
      failures: [
        [
          `core hash mismatch for CHAT_SYSTEM_PROMPT_CORE`,
          `  fixture expects ${fixture.coreHash}`,
          `  actual is      ${actualCoreHash}`,
          'The shared core changed — re-validate the fixture expected behavior,',
          'then update coreHash (and the script) deliberately.',
        ].join('\n'),
      ],
      summary: 'prompt mismatch',
    };
  }

  const prompt = loadPromptFiles(fixture.promptFiles);
  if (!prompt.ok) {
    return {
      name: fixture.name,
      ok: false,
      failures: [prompt.error],
      summary: 'prompt mismatch',
    };
  }
  const systemPrompt = composeChatSystemPrompt({
    core: CHAT_SYSTEM_PROMPT_CORE,
    overlay: prompt.content,
    suffix: fixture.systemPromptSuffix,
  });

  const adapter = new ScriptedAdapter(
    fixture.script,
    fixture.adapterConfigured !== false,
  );
  const executor = new ScriptedToolExecutor(fixture.script);
  let groundingWarnings = 0;
  let injectionEvents = 0;

  // #721 — correlationIds the loop routed through the execution port, in
  // call order. The routing assertion below reads this, not the adapter.
  const observedExecutionCorrelationIds: string[] = [];
  const llmExecution: LlmExecutionPort = {
    run: async (fn, meta) => {
      if (meta.correlationId)
        observedExecutionCorrelationIds.push(meta.correlationId);
      return fn(meta.signal);
    },
  };
  const usageRecorder: LlmUsageRecorderPort = {
    recordFromCompletion: () => undefined,
  };
  const safetyEvents: LlmSafetyEventPort = {
    recordGroundingWarning: () => {
      groundingWarnings += 1;
    },
    recordInjectionEvent: () => {
      injectionEvents += 1;
    },
  };

  const agent = new LlmAgentService<Record<string, never>>(
    {
      maxLlmRetries: 0,
      toolExecutionTimeoutMs: 5_000,
      globalAgentTimeoutMs: 30_000,
      maxOutputTokens: 1024,
      // #721 — per-fixture compaction opt-in (budget override keeps the
      // history small: compaction only cares over/under budget).
      compactionEnabled: fixture.compaction?.enabled === true,
      maxInputTokens: fixture.compaction?.maxInputTokens,
    },
    {
      llmExecution,
      usageRecorder,
      safetyEvents,
      toolExecutor: executor,
      adapter,
      metrics: NOOP_METRICS_PORT,
    },
  );

  let reply: LlmAgentReply | undefined;
  let loopError: unknown;
  for await (const event of agent.replyStream(
    {
      externalUserId: fixture.externalUserId,
      userId: fixture.userId,
      userText: fixture.userText,
      systemPrompt,
      history: fixture.history,
      correlationId: `eval-${fixture.name}`,
    },
    {},
  )) {
    if (event.type === 'error') {
      loopError = event.error;
    }
    if (event.type === 'done') {
      reply = event.reply;
    }
  }

  const failures: string[] = [];
  if (loopError) {
    failures.push(`agent loop error: ${errorMessage(loopError)}`);
  } else {
    if (adapter.callCount !== fixture.script.length) {
      failures.push(
        `adapter called ${adapter.callCount}x but the script declares ${fixture.script.length} round(s)`,
      );
    }
    // Unexpected tool attempts are always assertion failures — the loop must
    // never call a tool the fixture did not script.
    for (const attempt of executor.unexpectedAttempts) {
      failures.push(attempt);
    }
    // AC: the serialized tool arguments the loop hands to the executor must
    // match the scripted args exactly (key-order independent).
    for (const mismatch of executor.argsMismatches) {
      failures.push(mismatch);
    }
    // The scripted tool plan must be fully consumed unless the fixture
    // declares a remainder (call-cap / duplicate side effects).
    const expectedRemainder = fixture.expected.planRemainder ?? 0;
    const actualRemainder = executor.remainingPlanCount;
    if (actualRemainder !== expectedRemainder) {
      failures.push(
        `scripted tool plan leftover: expected ${expectedRemainder} call(s) unconsumed, got ${actualRemainder}`,
      );
    }
    if (!reply) {
      failures.push('no done event with a reply');
    } else {
      if (fixture.expected.toolSequence !== undefined) {
        const expected = fixture.expected.toolSequence;
        const actual = executor.actualTools;
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          failures.push(
            `tool sequence mismatch: expected [${expected.join(', ')}] got [${actual.join(', ') || 'none'}]`,
          );
        }
      }
      if (
        fixture.expected.exhausted !== undefined &&
        Boolean(reply.exhausted) !== fixture.expected.exhausted
      ) {
        failures.push(
          `exhausted flag mismatch: expected ${fixture.expected.exhausted} got ${Boolean(reply.exhausted)}`,
        );
      }
      if (fixture.expected.toolSummary !== undefined) {
        if (fixture.expected.toolSummary === null) {
          if (reply.toolSummary !== undefined) {
            failures.push(
              `toolSummary expected absent but got "${reply.toolSummary}"`,
            );
          }
        } else if (reply.toolSummary !== fixture.expected.toolSummary) {
          failures.push(
            `toolSummary mismatch: expected "${fixture.expected.toolSummary}" got "${reply.toolSummary ?? '(absent)'}"`,
          );
        }
      }
      for (const fragment of resolveReplyFragments(
        fixture.expected.replyTextContains ?? [],
        failures,
      )) {
        if (!reply.text.includes(fragment)) {
          failures.push(`reply is missing fragment "${fragment}"`);
        }
      }
      for (const fragment of resolveReplyFragments(
        fixture.expected.replyTextNotContains ?? [],
        failures,
      )) {
        if (reply.text.includes(fragment)) {
          failures.push(`reply contains forbidden fragment "${fragment}"`);
        }
      }
      // Tool-result leak guard (#161): nothing in the messages sent to the
      // model across ANY round may carry the forbidden fragments (e.g. raw
      // sanitized error text). Retaining every request makes an earlier
      // round's leak observable, not just the last one.
      const serializedToolResults = JSON.stringify(adapter.allRequests);
      for (const fragment of fixture.expected.toolResultsNotContain ?? []) {
        if (serializedToolResults.includes(fragment)) {
          failures.push(
            `tool results sent to the model contain forbidden fragment "${fragment}"`,
          );
        }
      }
      // State-based leak guard (#505): nothing in ANY recorded provider
      // request may carry the forbidden fragments — this asserts system
      // behavior (what was sent), not the scripted reply, so it cannot be
      // satisfied tautologically.
      for (const fragment of fixture.expected.requestNotContains ?? []) {
        if (serializedToolResults.includes(fragment)) {
          failures.push(
            `requestNotContains: forbidden fragment "${fragment}" reached a provider request`,
          );
        }
      }
      const expectedWarnings = fixture.expected.groundingWarnings ?? 0;
      if (groundingWarnings !== expectedWarnings) {
        failures.push(
          `grounding warnings: expected ${expectedWarnings} got ${groundingWarnings}`,
        );
      }
      const expectedInjectionEvents = fixture.expected.injectionEvents ?? 0;
      if (injectionEvents !== expectedInjectionEvents) {
        failures.push(
          `injection events: expected ${expectedInjectionEvents} got ${injectionEvents}`,
        );
      }
      // Execution-port routing for compaction (#703/#721): the summary call
      // must travel through llmExecution.run like every other provider call.
      if (fixture.expected.compactionViaExecutionPort === true) {
        const seen = observedExecutionCorrelationIds.some(
          isCompactionCorrelationId,
        );
        if (!seen) {
          failures.push(
            'expected a compaction call through llmExecution.run but none was observed',
          );
        }
      }
      // Plan step (#207 item 2): a scripted plan line (`content` on a tool
      // round) must survive into the next round's messages — the loop must
      // not drop the assistant message that accompanies tool calls. Checked
      // against every request the loop made.
      const serializedMessages = JSON.stringify(adapter.allRequests);
      for (const round of fixture.script) {
        if (round.content !== undefined) {
          if (!serializedMessages.includes(round.content)) {
            failures.push(
              `plan line "${round.content}" was dropped before the next round`,
            );
          }
        }
      }
      // Request contracts (#227): assert what the loop actually sent — system
      // prompt, user message, tool definitions and tool choice.
      const allRequests = adapter.allRequests;
      const contracts = fixture.expected.requestContracts ?? [];
      for (const [i, contract] of contracts.entries()) {
        const matchingRounds =
          contract.round === undefined
            ? allRequests.map((_, index) => index)
            : [contract.round];
        if (allRequests.length === 0) {
          failures.push(
            `requestContracts[${i}] cannot apply: the loop made no provider request`,
          );
          continue;
        }
        let applied = false;
        for (const roundIndex of matchingRounds) {
          const request = allRequests[roundIndex];
          if (!request) {
            failures.push(
              `requestContracts[${i}].round ${roundIndex} has no recorded request (loop made ${allRequests.length})`,
            );
            continue;
          }
          applied = true;
          const systemMessage = request.messages.find(
            (message) => message.role === 'system',
          );
          const systemContent = systemMessage?.content ?? '';
          for (const fragment of contract.systemPromptContains ?? []) {
            if (!systemContent.includes(fragment)) {
              failures.push(
                `requestContracts[${i}] round ${roundIndex}: system prompt is missing "${fragment}"`,
              );
            }
          }
          const userMessage = [...request.messages]
            .reverse()
            .find((message) => message.role === 'user');
          const userContent = userMessage?.content ?? '';
          for (const fragment of contract.userMessageContains ?? []) {
            if (!userContent.includes(fragment)) {
              failures.push(
                `requestContracts[${i}] round ${roundIndex}: user message is missing "${fragment}"`,
              );
            }
          }
          const toolNames = new Set(request.tools.map((tool) => tool.name));
          for (const toolName of contract.toolsInclude ?? []) {
            if (!toolNames.has(toolName)) {
              failures.push(
                `requestContracts[${i}] round ${roundIndex}: tool definition "${toolName}" is missing from the request`,
              );
            }
          }
          if (contract.toolChoice !== undefined) {
            if (
              contract.toolChoice === null &&
              request.toolChoice !== undefined
            ) {
              failures.push(
                `requestContracts[${i}] round ${roundIndex}: toolChoice must be absent but is "${request.toolChoice}"`,
              );
            } else if (
              contract.toolChoice !== null &&
              request.toolChoice !== contract.toolChoice
            ) {
              failures.push(
                `requestContracts[${i}] round ${roundIndex}: toolChoice expected "${contract.toolChoice}" got "${request.toolChoice ?? '(absent)'}"`,
              );
            }
          }
        }
        if (!applied) {
          failures.push(
            `requestContracts[${i}] matched no recorded request (loop made ${allRequests.length})`,
          );
        }
      }
    }
  }

  return {
    name: fixture.name,
    ok: failures.length === 0,
    failures,
    summary: `tools=[${executor.actualTools.join(', ') || 'none'}] exhausted=${Boolean(reply?.exhausted)} warnings=${groundingWarnings}`,
  };
}
