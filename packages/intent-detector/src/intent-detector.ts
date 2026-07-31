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
  /** Keywords that match greeting intent (case-insensitive) */
  greetingKeywords: string[];
  /** Keywords that match self-introduction intent (case-insensitive) */
  selfIntroKeywords: string[];
  /** Max characters to check at the start of the message */
  maxPrefixLength: number;
}

const DEFAULT_CONFIG: IntentConfig = {
  greetingKeywords: [
    'hi', 'hello', 'hey', 'chào', 'xin chào', 'good morning',
    'good afternoon', 'good evening', 'chào buổi sáng',
    'chào buổi tối', 'sup', 'yo',
  ],
  selfIntroKeywords: [
    'bạn là ai', 'bạn tên gì', 'bạn làm gì', 'tên bạn',
    'giới thiệu', 'bạn là gì', 'ai vậy', 'mình là ai',
  ],
  maxPrefixLength: 30,
};

export class IntentDetector {
  private readonly config: IntentConfig;
  private readonly greetingRegex: RegExp;
  private readonly selfIntroRegex: RegExp;

  constructor(config?: Partial<IntentConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    const greetingPattern = this.config.greetingKeywords
      .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    this.greetingRegex = new RegExp(
      `^\\s*(?:${greetingPattern})\\b`,
      'i',
    );

    const selfIntroPattern = this.config.selfIntroKeywords
      .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    this.selfIntroRegex = new RegExp(
      `^\\s*(?:${selfIntroPattern})\\b`,
      'i',
    );
  }

  /**
   * Detect intent from user message.
   * Checks only the first `maxPrefixLength` characters.
   */
  detect(message: string): IntentMatch {
    const prefix = message.slice(0, this.config.maxPrefixLength).trim();

    if (this.selfIntroRegex.test(prefix)) {
      return { intent: 'self_intro', matchedKeyword: this.findMatch(prefix, this.config.selfIntroKeywords) };
    }

    if (this.greetingRegex.test(prefix)) {
      return { intent: 'greeting', matchedKeyword: this.findMatch(prefix, this.config.greetingKeywords) };
    }

    return { intent: 'unknown' };
  }

  private findMatch(text: string, keywords: string[]): string | undefined {
    const lower = text.toLowerCase();
    for (const kw of keywords) {
      if (lower.startsWith(kw.toLowerCase())) return kw;
    }
    return undefined;
  }
}
