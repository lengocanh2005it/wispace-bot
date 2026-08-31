import { redactSecrets } from './secret-redaction.utils';

export interface InjectionCheckResult {
  isInjection: boolean;
  reason?: string;
}

/** Max chars before we treat a message as a potential token-overflow attack. */
const MAX_USER_TEXT_LENGTH = 2000;
const MAX_UNTRUSTED_TEXT_CHARS = 1000;
const MAX_SANITIZED_TOOL_RESULT_CHARS = 8000;
const UNSAFE_TEXT_PLACEHOLDER = '[redacted unsafe instruction-like text]';
const TRUNCATED_SUFFIX = '... [truncated]';

function stripUnsafeControlChars(text: string): string {
  return Array.from(text)
    .map((char) => {
      const code = char.charCodeAt(0);
      const isAllowedWhitespace = code === 9 || code === 10 || code === 13;
      const isUnsafeControl =
        !isAllowedWhitespace && ((code >= 0 && code <= 31) || code === 127);
      return isUnsafeControl ? ' ' : char;
    })
    .join('');
}

/**
 * Unicode confusable characters that can bypass Latin-only regex patterns.
 * Maps Cyrillic/Greek lookalikes to their Latin equivalents.
 */
const CONFUSABLE_MAP: Record<string, string> = {
  '\u0430': 'a', // Cyrillic а
  '\u0435': 'e', // Cyrillic е
  '\u043E': 'o', // Cyrillic о
  '\u0440': 'p', // Cyrillic р
  '\u0441': 'c', // Cyrillic с
  '\u0443': 'y', // Cyrillic у → approximate to y
  '\u0445': 'x', // Cyrillic х
  '\u0456': 'i', // Ukrainian і
  '\u03B1': 'a', // Greek α
  '\u03B5': 'e', // Greek ε
  '\u03BF': 'o', // Greek ο
  '\u03C1': 'p', // Greek ρ
};

function normalizeConfusables(text: string): string {
  return Array.from(text)
    .map((char) => CONFUSABLE_MAP[char] ?? char)
    .join('');
}

function normalizeForPromptScan(text: string): string {
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u200B-\u200F\uFEFF]/g, '')
    .replace(/[""]/g, '"')
    .replace(/['']/g, "'")
    .replace(/\s+/g, ' ')
    .toLowerCase();
  return normalizeConfusables(normalized);
}

/**
 * Patterns that strongly indicate prompt injection attempts.
 * Each entry: [pattern, reason label]
 */
const INJECTION_PATTERNS: Array<[RegExp, string]> = [
  // Instruction override
  [
    /ignore\s+(all\s+)?(previous|prior|above|earlier|old)\s+instructions?/i,
    'instruction_override',
  ],
  [
    /disregard\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
    'instruction_override',
  ],
  [
    /forget\s+(everything|all\s+instructions?|your\s+instructions?)/i,
    'instruction_override',
  ],
  [
    /bỏ\s*qua\s+(mọi\s+)?(hướng\s*dẫn|lệnh)\s*(trước|cũ|trên)/i,
    'instruction_override',
  ],
  [
    /(?:tu|từ)\s+giờ\s+(?:trở\s+đi|tro\s+di)?\s*(?:bạn|ban|mày|may)?\s*(?:là|la|hãy|hay|phải|phai)/i,
    'instruction_override',
  ],
  [
    /(?:quên|quen)\s+(?:hết|het|mọi|moi|tất\s*cả|tat\s*ca)\s+(?:hướng\s*dẫn|huong\s*dan|lệnh|lenh|chỉ\s*dẫn|chi\s*dan)/i,
    'instruction_override',
  ],

  // Injected role markers — checked before persona_override to get correct reason
  [/\n\s*#{1,3}\s*system\b/i, 'injected_role_marker'],
  [/\n\s*<\s*system\s*>/i, 'injected_role_marker'],
  [/\n\s*\[\s*system\s*\]/i, 'injected_role_marker'],
  [/```\s*system\b/i, 'injected_role_marker'],
  [/\n\s*system\s*:\s*\n/i, 'injected_role_marker'],
  [
    /(?:^|\n)\s*(?:system|developer|assistant|tool)\s*:/i,
    'injected_role_marker',
  ],
  [
    /(?:^|\n)\s*(?:hệ\s*thống|he\s*thong|nhà\s*phát\s*triển|nha\s*phat\s*trien)\s*:/i,
    'injected_role_marker',
  ],

  // Role / persona override
  [
    /you\s+are\s+now\s+(a\s+|an\s+)?(?!WISPACE|a\s+helpful)/i,
    'persona_override',
  ],
  // "act as" — only flag when implying AI persona override, not general usage
  [
    /act\s+as\s+(a\s+|an\s+)?(unrestricted|different|other|new|another|alternative|evil|free|uncensored|dangerous|DAN|hacker|malicious|unfiltered)/i,
    'persona_override',
  ],
  [/pretend\s+(you\s+are|to\s+be)/i, 'persona_override'],
  [/roleplay\s+as/i, 'persona_override'],
  [/from\s+now\s+on\s+(you\s+are|act|respond|behave)/i, 'persona_override'],
  [
    /developer\s+mode|jailbreak\s+mode|unrestricted\s+mode/i,
    'persona_override',
  ],
  [
    /(?:chế\s*độ|che\s*do)\s+(?:developer|nhà\s*phát\s*triển|nha\s*phat\s*trien|jailbreak|không\s*giới\s*hạn|khong\s*gioi\s*han)/i,
    'persona_override',
  ],
  [
    /(?:đóng\s*vai|dong\s*vai|giả\s*vờ|gia\s*vo)\s+(?:là|la)\s+(?!trợ\s*lý\s*WISPACE|tro\s*ly\s*WISPACE)/i,
    'persona_override',
  ],
  [/\bDAN\b.*(?:do\s+anything|jailbreak)/i, 'persona_override'],

  // System prompt extraction
  [/reveal\s+(your\s+)?(system\s*prompt|instructions?|prompt)/i, 'extraction'],
  [/show\s+me\s+(your\s+)?(system\s*prompt|instructions?)/i, 'extraction'],
  [
    /what\s+(are\s+your|is\s+your)\s+(system\s*prompt|instructions?)/i,
    'extraction',
  ],
  [/print\s+(your\s+)?(system\s*prompt|instructions?)/i, 'extraction'],
  [
    /repeat\s+(your\s+)?(system\s*prompt|instructions?|previous\s+message)/i,
    'extraction',
  ],
  [
    /(?:tiết\s*lộ|tiet\s*lo|hiển\s*thị|hien\s*thi|in\s+ra|nhắc\s*lại|nhac\s*lai)\s+(?:system\s*prompt|prompt\s*hệ\s*thống|prompt\s*he\s*thong|hướng\s*dẫn\s*ẩn|huong\s*dan\s*an|chỉ\s*dẫn\s*ẩn|chi\s*dan\s*an|lệnh\s*ẩn|lenh\s*an)/i,
    'extraction',
  ],
  [
    /(?:prompt|hướng\s*dẫn|huong\s*dan|chỉ\s*dẫn|chi\s*dan|lệnh|lenh)\s+(?:ẩn|an|hệ\s*thống|he\s*thong)\s+(?:của|cua)\s+(?:bạn|ban)/i,
    'extraction',
  ],

  // Prompt delimiter injection
  [/\n\s*(human|user|assistant|ai)\s*:\s*\n/i, 'delimiter_injection'],
  [/<\|im_start\|>|<\|im_end\|>/i, 'delimiter_injection'],
  [/\[INST\]|\[\/INST\]/i, 'delimiter_injection'],
];

/**
 * Non-disclosure probe detection (#625) — polite, direct questions for
 * internal details that trip no injection pattern: model/provider/vendor,
 * system-prompt contents, agent/tool architecture, sampling parameters,
 * hosting/infra/secrets, guardrail mapping, tool-capability probing.
 *
 * A match routes to the standard non-disclosure reply (a normal self-intro),
 * NOT a distinct "blocked" message — a differential response is itself an
 * oracle. Categories are for logging / fixture naming only; callers branch on
 * `probed`, never on `category`.
 */
export type DisclosureProbeCategory =
  | 'model'
  | 'prompt'
  | 'arch'
  | 'params'
  | 'infra'
  | 'guardrail'
  | 'tool-probe'
  | 'debug';

export interface DisclosureProbeResult {
  probed: boolean;
  category?: DisclosureProbeCategory;
}

const DISCLOSURE_PROBE_PATTERNS: Array<[RegExp, DisclosureProbeCategory]> = [
  // ── model / provider / vendor / version / fingerprint ──────────────────
  [/\b(which|what)\s+(ai\s+)?(model|llm)\b/i, 'model'],
  [
    /\b(are|were)\s+you\s+(built|based|powered|trained|made|created)\s+(on|by|with|from)\b/i,
    'model',
  ],
  [/\bwho\s+(made|created|built|trained|developed)\s+you\b/i, 'model'],
  [/\bare\s+you\s+(chatgpt|gpt|claude|gemini|bard|copilot)\b/i, 'model'],
  [
    /\b(chatgpt|gpt|claude|gemini|bard|llama)\s+(hay|or)\s+(chatgpt|gpt|claude|gemini|bard|llama)\b/i,
    'model',
  ],
  [/\b(knowledge\s+cutoff|context\s+window|cua\s+so\s+ngu\s+canh)\b/i, 'model'],
  [/\b(model|mo\s*hinh)\s+(nao|gi|j)\b/i, 'model'],
  [/\b(chay|dung|su\s*dung|xai)\s+(model|mo\s*hinh|llm)\b/i, 'model'],
  [
    /\b(model|mo\s*hinh|llm)\b.{0,20}\b(ban\s+(dang\s+)?(dung|xai)|cua\s+ban)\b/i,
    'model',
  ],
  [/\bcau\s*hinh\b.{0,15}\b(model|mo\s*hinh|he\s*thong|llm)\b/i, 'model'],
  [
    /\b(ban|may)\s+(la|dung|co\s*phai(\s*la)?)\s+(chatgpt|gpt|claude|gemini|bard)\b/i,
    'model',
  ],
  [
    /\bai\s+(tao|lam|phat\s*trien|huan\s*luyen|xay\s*dung)\s+ra\s+(ban|may)\b/i,
    'model',
  ],
  [/\b(provider|nha\s*cung\s*cap|vendor)\b.{0,20}\b(nao|gi|j)\b/i, 'model'],
  [
    /\b(use|using|powered\s+by|based\s+on|goi|call)\b.{0,30}\b(openai|anthropic|openrouter|azure|minimax|vertex|bedrock|groq|deepseek)\b/i,
    'model',
  ],
  [/\bphien\s*ban\b.{0,20}\b(model|mo\s*hinh|ban|gpt|claude)\b/i, 'model'],
  [
    /(什么模型|哪个模型|哪个大模型|模型版本|供应商|提供商|你是什么ai|你是谁开发|你是chatgpt|你是gpt|知识截止)/i,
    'model',
  ],

  // ── system prompt / instructions extraction (broad forms) ──────────────
  [
    /\b(system\s*prompt|system\s*message|initial\s+instructions?|original\s+instructions?)\b/i,
    'prompt',
  ],
  [
    /\brepeat\s+(everything|all|the\s+text|the\s+words?)\s+(above|before)\b/i,
    'prompt',
  ],
  [/\bwhat\s+(were|was)\s+you\s+told\b/i, 'prompt'],
  [
    /\b(summarize|translate|print|show|reveal|paste|output|give\s+me)\s+(your\s+)?(instructions?|prompt|guidelines?|rules?)\b/i,
    'prompt',
  ],
  // Spaced-out letters (taxonomy G): "s y s t e m   p r o m p t".
  // ponytail: single hand-rolled keyword; broaden only if a real bypass shows up.
  [
    /s\W{0,2}y\W{0,2}s\W{0,2}t\W{0,2}e\W{0,2}m\W{0,3}p\W{0,2}r\W{0,2}o\W{0,2}m\W{0,2}p\W{0,2}t/i,
    'prompt',
  ],
  [/\bprompt\s+(he\s*thong|goc|ban\s*dau|an)\b/i, 'prompt'],
  [
    /\b(nhac\s*lai|lap\s*lai|in\s*ra|doc\s*lai|viet\s*lai)\b.{0,30}\b(o\s*tren|phia\s*tren|truoc\s*do|dau\s*tien|tin\s*nhan\s*dau)\b/i,
    'prompt',
  ],
  [
    /\b(ban|may)\s+duoc\s+(dan|huong\s*dan|cap|giao)\s+(gi|j|nhung\s*gi)\b/i,
    'prompt',
  ],
  [
    /\b(in\s*ra|liet\s*ke|cho\s*xem|hien\s*thi|tiet\s*lo)\b.{0,30}\b(huong\s*dan|chi\s*dan|instruction)\b/i,
    'prompt',
  ],
  [/\bhuong\s*dan\s+(an|goc|ban\s*dau|he\s*thong)\b/i, 'prompt'],
  [
    /(系统提示|系统提示词|系统指令|重复上面|重复以上|你的指令|你被告知什么|之前.*对话)/i,
    'prompt',
  ],

  // ── agent / architecture internals ────────────────────────────────────
  [/\bhow\s+many\s+(tools?|functions?)\b/i, 'arch'],
  [
    /\b(list|name|show|enumerate)\s+(your\s+|the\s+|all\s+)?(tools?|functions?)\b/i,
    'arch',
  ],
  [/\b(tool|function)\s+schema\b/i, 'arch'],
  [/\bschema\b.{0,15}\b(tool|function|cong\s*cu|ham)\b/i, 'arch'],
  [
    /\b(use|using|dung|su\s*dung)\s+(rag|vector\s*db|langchain|llamaindex|llama\s*index)\b/i,
    'arch',
  ],
  [/\bmax\s+iterations?\b/i, 'arch'],
  [/\b(describe|explain|mo\s*ta)\b.{0,30}\bpipeline\b/i, 'arch'],
  [/\b(bao\s*nhieu|may)\s+(tool|function|cong\s*cu|ham)\b/i, 'arch'],
  [
    /\b(liet\s*ke|ke\s*ten|ten\s*cac|ten\s*nhung)\b.{0,20}\b(tool|function|ham|cong\s*cu)\b/i,
    'arch',
  ],
  [/\bpipeline\s+xu\s*ly\b/i, 'arch'],
  [
    /(多少个?工具|多少个?函数|列出.*工具|工具列表|什么框架|处理流程|向量数据库)/i,
    'arch',
  ],

  // ── inference / sampling parameters ──────────────────────────────────
  [
    /\b(seed|system\s*fingerprint|frequency\s*penalty|presence\s*penalty)\b/i,
    'params',
  ],
  [
    /\b(temperature|top[_\s-]?p|top[_\s-]?k|max[_\s-]?tokens?)\b\s*[:=]/i,
    'params',
  ],
  [
    /\b(your|you\s+(set|use)|ban\s+(set|dat|dung)|cua\s+ban)\b.{0,25}\b(temperature|top[_\s-]?p|sampling|tham\s*so\s*sinh)\b/i,
    'params',
  ],
  [
    /\b(temperature|top[_\s-]?p|sampling\s+parameters?|tham\s*so\s*(sinh|suy\s*luan))\b.{0,25}\b(bao\s*nhieu|set\s+to|value|cua\s+ban|la\s*gi|do\s+you\s+(set|use))\b/i,
    'params',
  ],
  [/(温度参数|采样参数|随机种子)/i, 'params'],

  // ── infrastructure / deployment / secrets fishing ────────────────────
  [
    /\bwhere\s+(are|is)\s+(you|this\s+bot)\s+(hosted|deployed|running)\b/i,
    'infra',
  ],
  [
    /\b(host|hosted|deploy(ed)?|running)\b.{0,20}\b(aws|gcp|azure|vps|heroku|render|railway|digitalocean)\b/i,
    'infra',
  ],
  [
    /\b(which|what)\s+(server|cloud|database|db)\b.{0,20}\b(you|your|this\s+bot)\b/i,
    'infra',
  ],
  [/\b(internal|wispace)\s+(api\s+)?key\b/i, 'infra'],
  [/\b(environment\s+variables?|env\s+vars?|\.env\b)/i, 'infra'],
  [/\b(real|actual|internal)\s+rate\s+limit\b/i, 'infra'],
  [
    /\brate\s+limit\b.{0,20}\b(per\s+minute|that\s*su|thuc\s*su|internal)\b/i,
    'infra',
  ],
  [
    /\b(host|deploy|chay)\b.{0,15}\b(o\s*dau|tren\s*dau|may\s*chu\s*nao)\b/i,
    'infra',
  ],
  [/\b(database|db|co\s*so\s*du\s*lieu)\b.{0,15}\b(nao|gi|j)\b/i, 'infra'],
  [
    /\b(dung|su\s*dung|xai)\b.{0,15}\b(postgres|redis|mysql|mongo(db)?)\b/i,
    'infra',
  ],
  [/\bbien\s*moi\s*truong\b/i, 'infra'],
  [/\bduong\s*dan\b.{0,25}\b(file|prompt|server|may\s*chu)\b/i, 'infra'],
  [
    /(部署在哪|托管在哪|什么数据库|环境变量|真实的?速率限制|内部密钥|api密钥)/i,
    'infra',
  ],

  // ── guardrail mapping (boundary extraction without the prompt text) ──
  [
    /\b(what|which)\s+(topics?|questions?|things?|words?)\b.{0,40}\b(refuse|reject|won'?t|can'?t|not\s+allowed|blocked?)\b/i,
    'guardrail',
  ],
  [/\bhow\s+do\s+you\s+detect\s+(prompt\s+)?injection\b/i, 'guardrail'],
  [
    /\b(list|enumerate|show)\s+(your\s+|all\s+)?(rules?|guardrails?|restrictions?|guidelines?)\b/i,
    'guardrail',
  ],
  [
    /\bwhat\s+are\s+you\s+(not\s+allowed|forbidden|prohibited)\s+to\b/i,
    'guardrail',
  ],
  [/\bblocked\s+(keywords?|words?|phrases?)\b/i, 'guardrail'],
  [
    /\b(chu\s*de|cau\s*hoi)\s+nao\b.{0,30}\b(tu\s*choi|khong\s*tra\s*loi|bi\s*chan)\b/i,
    'guardrail',
  ],
  [
    /\b(phat\s*hien)\b.{0,20}\b(prompt\s*injection|tan\s*cong\s*prompt)\b/i,
    'guardrail',
  ],
  [
    /\b(liet\s*ke|ke\s*het)\b.{0,20}\b(quy\s*tac|luat|guardrail|rang\s*buoc)\b/i,
    'guardrail',
  ],
  [/\b(ban|may)\s+(khong\s*duoc|bi\s*cam)\s+lam\s+gi\b/i, 'guardrail'],
  [/\btu\s*khoa\b.{0,20}\b(bi\s*chan|cam)\b/i, 'guardrail'],
  [
    /(拒绝什么话题|哪些话题.*拒绝|如何检测.*注入|列出.*规则|被禁止做什么|屏蔽的?关键词)/i,
    'guardrail',
  ],

  // ── tool / capability probing to prep abuse (taxonomy K) ─────────────
  [
    /\b(create|make|generate)\b.{0,30}\bexercise\b.{0,15}\bfor\s+(another|other|someone\s+else|a\s+different)\b/i,
    'tool-probe',
  ],
  [
    /\bif\s+i\s+(give|pass|provide|send)\s+.{0,20}\b(another|different|someone\s+else'?s)\s+(user\s*id|userid|id)\b/i,
    'tool-probe',
  ],
  [
    /\breschedule\b.{0,25}\b(parameters?|date\s+format|takes?|accepts?)\b/i,
    'tool-probe',
  ],
  [
    /\breschedule\b.{0,30}\b(tham\s*so|format\s*ngay|nhan\s*gi|nhan\s*tham)\b/i,
    'tool-probe',
  ],
  [
    /\btao\s+bai\s*tap\s+cho\s+(user|nguoi\s*dung|hoc\s*vien|ban)\s+khac\b/i,
    'tool-probe',
  ],
  [
    /\b(dua|truyen|nhap|gui)\b.{0,20}\buserid\s+(khac|nguoi\s*khac)\b/i,
    'tool-probe',
  ],
  [/\bgoi\s+api\s+voi\s+id\b.{0,20}\b(khac|nguoi\s*khac)\b/i, 'tool-probe'],
  [/(给其他用户|其他用户.*练习|需要什么id)/i, 'tool-probe'],

  // ── error / debug-channel probing (taxonomy I) ──────────────────────
  [/\b(verbose|debug)\s+mode\b/i, 'debug'],
  [/\b(enable|turn\s+on|bat|bật)\s+(verbose|debug)\b/i, 'debug'],
  [/\b(full|complete|raw)\s+(response|json)\b.{0,20}\bmetadata\b/i, 'debug'],
  [/\b(stack\s*trace|traceback|full\s+error)\b/i, 'debug'],
  [/\b(che\s*do|chế\s*độ)\s+(verbose|debug|go\s*roi|gỡ\s*rối)\b/i, 'debug'],
  [
    /\btra\s+(ve|về)\s+.{0,20}\b(metadata|json\s+day\s+du|json\s+đầy\s+đủ)\b/i,
    'debug',
  ],
  [/(调试模式|详细模式|完整的?元数据|堆栈跟踪)/i, 'debug'],
];

/** Leetspeak fold for the disclosure scan only (taxonomy G): "pr0mpt" → "prompt". */
function foldLeet(text: string): string {
  return text
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/@/g, 'a')
    .replace(/\$/g, 's');
}

/**
 * Detect a direct probe for internal details (#625). Resilient to the shared
 * normalization (diacritics, đ/Đ, confusables, zero-width, spacing) plus a
 * leetspeak fold.
 *
 * ponytail: base64 / ROT13 decoding of the whole message (taxonomy G) is
 * deliberately NOT done here — heavier work + false-positive surface on every
 * chat turn for a niche bypass. The prompt core still forbids answering an
 * encoded probe; add a decode pass only if a real bypass shows up.
 */
export function detectDisclosureProbe(userText: string): DisclosureProbeResult {
  const text = userText ?? '';
  if (!text.trim()) return { probed: false };

  // `normalizeForPromptScan` (NFD) does NOT decompose Vietnamese đ/Đ — fold
  // it here so ASCII patterns (`dau`, `duoc`, `de`, ...) match "đâu", "được".
  const normalized = normalizeForPromptScan(text).replace(/đ/g, 'd');
  const candidates = [text, normalized, foldLeet(normalized)];

  for (const [pattern, category] of DISCLOSURE_PROBE_PATTERNS) {
    for (const candidate of candidates) {
      if (pattern.test(candidate)) {
        return { probed: true, category };
      }
    }
  }
  return { probed: false };
}

/** Detects repetition-based context flooding (e.g. "abc " × 50). */
function hasRepetitionFlood(text: string): boolean {
  // A token of 3+ distinct chars repeated >25 times consecutively
  return /([^\s]{3,20}\s*)\1{25,}/i.test(text);
}

function scanPatterns(text: string): InjectionCheckResult {
  if (hasRepetitionFlood(text)) {
    return { isInjection: true, reason: 'repetition_flood' };
  }

  const candidates = [text, normalizeForPromptScan(text)];
  for (const [pattern, reason] of INJECTION_PATTERNS) {
    if (candidates.some((candidate) => pattern.test(candidate))) {
      return { isInjection: true, reason };
    }
  }

  return { isInjection: false };
}

/** Check user-supplied input — applies length limit + pattern scan. */
export function detectPromptInjection(userText: string): InjectionCheckResult {
  const text = userText ?? '';

  if (text.length > MAX_USER_TEXT_LENGTH) {
    return { isInjection: true, reason: 'message_too_long' };
  }

  return scanPatterns(text);
}

export function sanitizeUntrustedTextForLlm(
  value: string,
  options?: { maxChars?: number; unsafePlaceholder?: string },
): { text: string; wasSanitized: boolean; reason?: string } {
  const withoutControlChars = stripUnsafeControlChars(value).trim();
  const check = scanPatterns(withoutControlChars);

  if (check.isInjection) {
    return {
      text: options?.unsafePlaceholder ?? UNSAFE_TEXT_PLACEHOLDER,
      wasSanitized: true,
      reason: check.reason,
    };
  }

  // Input-side secret hygiene (#632): shapes + registered runtime values
  // never reach model context through this boundary.
  const normalized0 = withoutControlChars.replace(/\s+/g, ' ').trim();
  const secretCheck = redactSecrets(normalized0);
  let normalized = secretCheck.text;
  let truncated = false;
  const maxChars = options?.maxChars ?? MAX_UNTRUSTED_TEXT_CHARS;
  if (normalized.length > maxChars) {
    const suffix =
      maxChars > TRUNCATED_SUFFIX.length ? TRUNCATED_SUFFIX : '...';
    normalized = `${normalized.slice(0, maxChars - suffix.length).trimEnd()}${suffix}`;
    truncated = true;
  }

  if (secretCheck.redacted) {
    return { text: normalized, wasSanitized: true, reason: 'secret_redacted' };
  }
  if (truncated) {
    return { text: normalized, wasSanitized: true, reason: 'text_too_long' };
  }
  return { text: normalized, wasSanitized: normalized !== value };
}

function sanitizeUntrustedValueForLlm(value: unknown): {
  value: unknown;
  wasSanitized: boolean;
  reason?: string;
} {
  if (typeof value === 'string') {
    const result = sanitizeUntrustedTextForLlm(value, {
      maxChars: MAX_SANITIZED_TOOL_RESULT_CHARS,
    });
    return {
      value: result.text,
      wasSanitized: result.wasSanitized,
      reason: result.reason,
    };
  }

  if (Array.isArray(value)) {
    let wasSanitized = false;
    let reason: string | undefined;
    const sanitized = value.map((entry) => {
      const result = sanitizeUntrustedValueForLlm(entry);
      wasSanitized ||= result.wasSanitized;
      reason ??= result.reason;
      return result.value;
    });
    return { value: sanitized, wasSanitized, reason };
  }

  if (value && typeof value === 'object') {
    let wasSanitized = false;
    let reason: string | undefined;
    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const result = sanitizeUntrustedValueForLlm(entry);
      sanitized[key] = result.value;
      wasSanitized ||= result.wasSanitized;
      reason ??= result.reason;
    }
    return { value: sanitized, wasSanitized, reason };
  }

  return { value, wasSanitized: false };
}

/** Check and sanitize tool result content before feeding it back to the LLM. */
export function sanitizeToolResultContent(content: string): {
  content: string;
  wasSanitized: boolean;
  reason?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const sanitizedText = sanitizeUntrustedTextForLlm(content, {
      maxChars: MAX_SANITIZED_TOOL_RESULT_CHARS,
    });
    return {
      content: sanitizedText.text,
      wasSanitized: sanitizedText.wasSanitized,
      reason: sanitizedText.reason,
    };
  }

  const sanitizedValue = sanitizeUntrustedValueForLlm(parsed);
  let sanitizedContent = JSON.stringify(sanitizedValue.value);
  let wasSanitized = sanitizedValue.wasSanitized;
  let reason = sanitizedValue.reason;

  const serializedCheck = scanPatterns(sanitizedContent);
  if (serializedCheck.isInjection) {
    return {
      content: JSON.stringify({ _sanitized: true }),
      wasSanitized: true,
      reason: serializedCheck.reason,
    };
  }

  if (sanitizedContent.length > MAX_SANITIZED_TOOL_RESULT_CHARS) {
    sanitizedContent = JSON.stringify({
      _truncated: true,
      preview: sanitizedContent.slice(0, MAX_SANITIZED_TOOL_RESULT_CHARS),
    });
    wasSanitized = true;
    reason ??= 'tool_result_too_long';
  }

  return {
    content: sanitizedContent,
    wasSanitized,
    reason,
  };
}
