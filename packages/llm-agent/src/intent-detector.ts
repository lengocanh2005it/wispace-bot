import { buildSafetyScanCandidates } from './utils/prompt-injection.utils';

/**
 * Lightweight intent detection for WISPACE bots.
 *
 * Detects greeting/self-intent BEFORE calling LLM, saving tokens.
 * Configurable keywords per platform — no hardcoding in gateway.
 */

export type IntentType = 'greeting' | 'self_intro' | 'unknown';

export interface IntentMatch {
  intent: IntentType;
  matchedKeyword?: string;
}

export interface IntentConfig {
  /** Keywords that match greeting intent (case-insensitive, canonicalized) */
  greetingKeywords: string[];
  /** Keywords that match self-introduction intent (case-insensitive, canonicalized) */
  selfIntroKeywords: string[];
  /** Max characters to check at the start of the message */
  maxPrefixLength: number;
}

type KeywordMatcher = {
  keyword: string;
  patterns: RegExp[];
};

const TOKEN_PATTERN = '[^\\p{L}\\p{N}]+';
const TOKEN_REGEX = /[\p{L}\p{N}]+/gu;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPrefixPattern(keywordCandidate: string): RegExp {
  const tokens = keywordCandidate.match(TOKEN_REGEX);
  if (!tokens?.length) return /^\s*$/u;

  const keywordPattern = tokens.map(escapeRegex).join(TOKEN_PATTERN);
  return new RegExp(`^\\s*${keywordPattern}(?=$|[^\\p{L}\\p{N}])`, 'iu');
}

function buildKeywordMatchers(keywords: readonly string[]): KeywordMatcher[] {
  return keywords.map((keyword) => ({
    keyword,
    patterns: buildSafetyScanCandidates(keyword)
      .slice(1)
      .map(buildPrefixPattern),
  }));
}

const DEFAULT_CONFIG: IntentConfig = {
  greetingKeywords: [
    'hi',
    'hello',
    'hey',
    'chào',
    'xin chào',
    'good morning',
    'good afternoon',
    'good evening',
    'chào buổi sáng',
    'chào buổi tối',
    'sup',
    'yo',
  ],
  selfIntroKeywords: [
    'bạn là ai',
    'bạn tên gì',
    'bạn làm gì',
    'tên bạn',
    'giới thiệu',
    'bạn là gì',
    'ai vậy',
    'mình là ai',
  ],
  maxPrefixLength: 30,
};

export class IntentDetector {
  private readonly config: IntentConfig;
  private readonly greetingMatchers: KeywordMatcher[];
  private readonly selfIntroMatchers: KeywordMatcher[];

  constructor(config?: Partial<IntentConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.greetingMatchers = buildKeywordMatchers(this.config.greetingKeywords);
    this.selfIntroMatchers = buildKeywordMatchers(
      this.config.selfIntroKeywords,
    );
  }

  /**
   * Detect intent from user message.
   * Checks only the first `maxPrefixLength` characters.
   */
  detect(message: string): IntentMatch {
    const prefix = message.slice(0, this.config.maxPrefixLength).trim();

    const selfIntroKeyword = this.findMatch(prefix, this.selfIntroMatchers);
    if (selfIntroKeyword !== undefined) {
      return {
        intent: 'self_intro',
        matchedKeyword: selfIntroKeyword,
      };
    }

    const greetingKeyword = this.findMatch(prefix, this.greetingMatchers);
    if (greetingKeyword !== undefined) {
      return {
        intent: 'greeting',
        matchedKeyword: greetingKeyword,
      };
    }

    return { intent: 'unknown' };
  }

  private findMatch(
    text: string,
    matchers: readonly KeywordMatcher[],
  ): string | undefined {
    const candidates = buildSafetyScanCandidates(text);
    return matchers.find(({ patterns }) =>
      patterns.some((pattern) =>
        candidates.some((candidate) => pattern.test(candidate)),
      ),
    )?.keyword;
  }
}
