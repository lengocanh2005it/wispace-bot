// Shared utilities — safety, scope, retry, text, privacy
export {
  CHAT_FAILURE_FALLBACK_MESSAGE,
  NON_DISCLOSURE_REPLY,
  buildPromptInjectionBlockedMessage,
  buildNonDisclosureReply,
  buildWispaceScopeRedirectMessage,
  buildClarificationMessage,
  buildClarificationCancelledMessage,
  buildClarificationUnavailableMessage,
  buildGroundingBlockedMessage,
  buildPrecreateExerciseUnavailableMessage,
  buildWriteToolDailyBudgetMessage,
  buildWriteToolPerMessageBudgetMessage,
} from '../messages';
export {
  detectPromptInjection,
  detectDisclosureProbe,
  sanitizeToolResultContent,
  sanitizeUntrustedTextForLlm,
} from './prompt-injection.utils';
export type {
  InjectionCheckResult,
  DisclosureProbeResult,
  DisclosureProbeCategory,
} from './prompt-injection.utils';
export { checkLlmGrounding } from './llm-grounding.utils';
export type { LlmGroundingResult } from './llm-grounding.utils';
export {
  isOpenAiRateLimitError,
  isOpenAiServerError,
} from './openai-error.utils';
export {
  isObviouslyOffTopic,
  isGreetingOnly,
  isAmbiguousMessage,
  normalizeScopeText,
} from './scope.utils';
export {
  detectPrivacyIntent,
  isConfirmationResponse,
  isCancellationResponse,
  type PrivacyIntent,
} from './privacy-intent.utils';
export { PrivacyStateService } from './privacy-state.service';
export { sanitizeReplyText } from './text.utils';
export { sleep, retryWithBackoff } from './retry.utils';
export { loadSystemPromptFile } from './load-system-prompt';
export {
  canonicalizeToolObservation,
  fitToolObservation,
  observationMarker,
  projectToolObservation,
  reduceToolObservation,
} from './tool-observation';
export type {
  ReducedToolObservation,
  ToolObservationOutcome,
} from './tool-observation';
export {
  SYSTEM_PROMPT_LEAK_MARKERS,
  checkFinalOutputSafety,
  type FinalOutputSafetyResult,
} from './final-output.utils';
export {
  CREDENTIAL_SHAPES,
  findCredentialShape,
} from './secret-patterns.utils';
export {
  collectRuntimeSecretValues,
  redactSecrets,
  registerRuntimeSecrets,
  resetRuntimeSecretsForTests,
  REDACTED_PLACEHOLDER,
} from './secret-redaction.utils';
