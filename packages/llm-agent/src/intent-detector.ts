import {
  DEFAULT_GREETING_KEYWORDS,
  matchStandaloneKeyword,
} from './utils/scope.utils';

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
}

const DEFAULT_CONFIG: IntentConfig = {
  greetingKeywords: [...DEFAULT_GREETING_KEYWORDS],
  selfIntroKeywords: [
    'bạn là ai',
    'bạn là ai vậy',
    'bạn tên gì',
    'bạn làm gì',
    'tên bạn',
    'giới thiệu',
    'bạn là gì',
    'ai vậy',
    'mình là ai',
  ],
};

export class IntentDetector {
  private readonly config: IntentConfig;

  constructor(config?: Partial<IntentConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Detect intent from user message.
   * Standalone intents must consume the full message; anything with content
   * after the keyword falls through to the normal chat pipeline.
   */
  detect(message: string): IntentMatch {
    const selfIntroKeyword = matchStandaloneKeyword(
      message,
      this.config.selfIntroKeywords,
    );
    if (selfIntroKeyword !== undefined) {
      return {
        intent: 'self_intro',
        matchedKeyword: selfIntroKeyword,
      };
    }

    const greetingKeyword = matchStandaloneKeyword(
      message,
      this.config.greetingKeywords,
      { allowGreetingSuffix: true },
    );
    if (greetingKeyword !== undefined) {
      return {
        intent: 'greeting',
        matchedKeyword: greetingKeyword,
      };
    }

    return { intent: 'unknown' };
  }
}
