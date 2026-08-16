import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import type { ChatHistoryMessage } from '@wispace/chat-history';
import { errorMessage } from '@wispace/bot-common';
import { LlmAgentService } from '../agent.service';
import { AGENT_TOOLS, isAgentToolName } from '../agent.tools';
import { NOOP_METRICS_PORT } from '../ports';
import type {
  LlmExecutionPort,
  LlmSafetyEventPort,
  LlmUsageRecorderPort,
  ToolExecutorPort,
} from '../ports';
import type { LlmProviderAdapter } from '../provider/llm-provider.adapter';
import type { LlmToolChatResponse } from '../provider/types';
import type { LlmAgentReply } from '../types';

/**
 * Golden-conversation eval harness for `LlmAgentService`.
 *
 * Fixtures (JSON, spec-style) declare the *expected* LLM behavior for a
 * scenario — which tools are called in which order, what tool results feed
 * back into the loop, and what the final reply should look like. The harness
 * replays each fixture against a scripted (frozen) LLM adapter and asserts
 * the orchestration loop honors the expectation: tool order, tool args vs
 * the `AGENT_TOOLS` schema, `toolSummary`/`exhausted` flags, and a
 * no-fabrication grounding guard.
 *
 * Fixtures reference the *real* chat system prompts by path + sha256 hash,
 * so any prompt/tool change fails the eval until the fixtures are
 * re-validated (see the repo AGENTS.md testing notes).
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
  /** Scripted parallel tool calls for this round. */
  toolCalls?: EvalScriptedToolCall[];
  /** Scripted final LLM text — must not be combined with toolCalls. */
  text?: string;
}

export interface EvalExpectation {
  /** Exact ordered list of tool names invoked across all rounds. */
  toolSequence?: string[];
  /** Every fragment must appear in the reply text. */
  replyTextContains?: string[];
  /** Fabrication guard — none of these may appear in the reply text. */
  replyTextNotContains?: string[];
  exhausted?: boolean;
  /** null = must be absent; string = must match exactly. */
  toolSummary?: string | null;
  /** Expected grounding-warning count (default 0). */
  groundingWarnings?: number;
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
   * Real prompt files this scenario runs against (e.g. the shared chat core
   * `packages/llm-agent/src/chat-system-prompt.ts` + a platform overlay),
   * composed with `\n\n` exactly like `PlatformAgentService.buildSystemPrompt`.
   * Hashes are of LF-normalized content, so checkouts with CRLF still match.
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
  const tool = AGENT_TOOLS.find((t) => t.name === toolName);
  if (!tool) {
    errors.push(`scripted tool "${toolName}" is not in AGENT_TOOLS`);
    return;
  }
  const params = tool.parameters;
  const properties = (params.properties ?? {}) as Record<
    string,
    { type?: string; enum?: unknown[] }
  >;
  const required = Array.isArray(params.required)
    ? (params.required as string[])
    : [];
  const value = args ?? {};

  for (const key of Object.keys(value)) {
    if (!(key in properties)) {
      if (params.additionalProperties === false) {
        errors.push(
          `tool "${toolName}" arg "${key}" is not allowed (additionalProperties=false)`,
        );
      }
      continue;
    }
    const prop = properties[key];
    const propValue = value[key];
    if (prop.type === 'string' && typeof propValue !== 'string') {
      errors.push(`tool "${toolName}" arg "${key}" must be a string`);
    } else if (prop.type === 'number' && typeof propValue !== 'number') {
      errors.push(`tool "${toolName}" arg "${key}" must be a number`);
    } else if (
      prop.type === 'integer' &&
      (typeof propValue !== 'number' || !Number.isInteger(propValue))
    ) {
      errors.push(`tool "${toolName}" arg "${key}" must be an integer`);
    } else if (prop.type === 'boolean' && typeof propValue !== 'boolean') {
      errors.push(`tool "${toolName}" arg "${key}" must be a boolean`);
    }
    if (
      Array.isArray(prop.enum) &&
      !prop.enum.some((option) => Object.is(option, propValue))
    ) {
      errors.push(
        `tool "${toolName}" arg "${key}" must be one of ${prop.enum.join('|')}`,
      );
    }
  }

  for (const key of required) {
    if (!(key in value)) {
      errors.push(`tool "${toolName}" is missing required arg "${key}"`);
    }
  }
}

function validateRound(round: unknown, index: number, errors: string[]): void {
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
      errors.push(
        `script[${index}].toolCalls[${j}].name "${call.name}" is not in AGENT_TOOLS`,
      );
    }
    if (call.args !== undefined && !isRecord(call.args)) {
      errors.push(`script[${index}].toolCalls[${j}].args must be an object`);
    } else {
      validateToolArgs(call.name, call.args, errors);
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
  if (!Array.isArray(raw.script)) {
    errors.push('script must be an array of rounds');
  } else if (raw.script.length === 0) {
    // Empty script = the LLM is never called (e.g. injection/off-topic early
    // returns). The runner fails loudly if the adapter is invoked anyway.
  } else {
    for (const [i, round] of raw.script.entries()) {
      validateRound(round, i, errors);
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
  }

  if (errors.length > 0) {
    return { errors };
  }

  return {
    fixture: {
      name: String(name),
      description:
        typeof raw.description === 'string' ? raw.description : undefined,
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
 * Loads all prompt files a fixture depends on and composes them with `\n\n`,
 * mirroring `PlatformAgentService.buildSystemPrompt` (core + overlay).
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
 * Frozen LLM adapter: returns the fixture's scripted responses in round
 * order. Fails loudly when the loop asks for more responses than scripted —
 * an early return (injection/off-topic) or an unexpected extra round shows
 * up as an adapter-call-count mismatch.
 */
export class ScriptedAdapter implements LlmProviderAdapter {
  callCount = 0;

  constructor(private readonly script: EvalScriptRound[]) {}

  readonly providerName = 'eval';

  isConfigured(): boolean {
    return true;
  }

  getDefaultModel(): string {
    return 'eval-model';
  }

  chatWithTools(): Promise<LlmToolChatResponse> {
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
      message: { role: 'assistant', toolCalls },
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
 * records every tool actually invoked. Any tool call that does not match the
 * script (or a script that runs out of responses) fails loudly — the loop
 * receives a `{ ok: false }` tool result, and the sequence assertion reports
 * the mismatch.
 */
export class ScriptedToolExecutor {
  readonly actualTools: string[] = [];
  private readonly plan: EvalScriptedToolCall[];

  constructor(script: EvalScriptRound[]) {
    this.plan = script.flatMap((round) => round.toolCalls ?? []);
  }

  readonly execute: ToolExecutorPort<Record<string, never>>['execute'] = (
    toolName,
  ) => {
    const expected = this.plan.shift();
    if (!expected || expected.name !== toolName) {
      return Promise.reject(
        new Error(
          `eval: unexpected tool "${toolName}" (scripted next: ${expected?.name ?? 'none'})`,
        ),
      );
    }
    this.actualTools.push(toolName);
    if (expected.fail !== undefined) {
      return Promise.reject(new Error(expected.fail));
    }
    return Promise.resolve(expected.result);
  };
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

  const prompt = loadPromptFiles(fixture.promptFiles);
  if (!prompt.ok) {
    return {
      name: fixture.name,
      ok: false,
      failures: [prompt.error],
      summary: 'prompt mismatch',
    };
  }
  const systemPrompt = fixture.systemPromptSuffix
    ? `${prompt.content}\n\n${fixture.systemPromptSuffix}`
    : prompt.content;

  const adapter = new ScriptedAdapter(fixture.script);
  const executor = new ScriptedToolExecutor(fixture.script);
  let groundingWarnings = 0;

  const llmExecution: LlmExecutionPort = {
    run: async (fn, meta) => fn(meta.signal),
  };
  const usageRecorder: LlmUsageRecorderPort = {
    recordFromCompletion: () => undefined,
  };
  const safetyEvents: LlmSafetyEventPort = {
    recordGroundingWarning: () => {
      groundingWarnings += 1;
    },
  };

  const agent = new LlmAgentService<Record<string, never>>(
    {
      maxLlmRetries: 0,
      toolExecutionTimeoutMs: 5_000,
      globalAgentTimeoutMs: 30_000,
      maxOutputTokens: 1024,
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
      for (const fragment of fixture.expected.replyTextContains ?? []) {
        if (!reply.text.includes(fragment)) {
          failures.push(`reply is missing fragment "${fragment}"`);
        }
      }
      for (const fragment of fixture.expected.replyTextNotContains ?? []) {
        if (reply.text.includes(fragment)) {
          failures.push(`reply contains forbidden fragment "${fragment}"`);
        }
      }
      const expectedWarnings = fixture.expected.groundingWarnings ?? 0;
      if (groundingWarnings !== expectedWarnings) {
        failures.push(
          `grounding warnings: expected ${expectedWarnings} got ${groundingWarnings}`,
        );
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
