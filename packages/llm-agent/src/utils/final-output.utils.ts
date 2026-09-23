import { CREDENTIAL_SHAPES } from './secret-patterns.utils';
import { buildSafetyScanCandidates } from './prompt-injection.utils';

/**
 * Final-output safety guardrail (#165): the last thing an LLM-generated
 * reply passes through before delivery. Input scanning and tool-result
 * sanitization can miss a direct or indirect injection response — this check
 * catches the model leaking system-prompt/instruction material or
 * credential-shaped content, and the caller fails closed to a generic reply.
 */

/** Distinctive system-prompt markers — if any appears in a REPLY, the model
 * is leaking instruction material. Kept in sync with CHAT_SYSTEM_PROMPT_CORE
 * by the marker-sync spec (a prompt edit breaks the spec deliberately). */
export const SYSTEM_PROMPT_LEAK_MARKERS = [
  'You are the WISPACE assistant',
  'WISPACE scope (mandatory)',
  'OUT-OF-SCOPE questions',
  'Crisis/self-harm (support handoff)',
  'Non-disclosure of internal details',
  'When NOT to call tools',
  'Do NOT act as a general-purpose assistant',
  'Multi-intent requests (2+ tasks in one message)',
  'Personal data — never fabricate',
] as const;

/**
 * Provider identifiers and explicit self-identification patterns. Common
 * words such as "llama" and "gemini" need first-person/provider context so
 * ordinary vocabulary and proper names remain usable (#1046).
 */
const VENDOR_MODEL_PATTERNS: Array<RegExp> = [
  /\b(open\s*ai|anthropic|openrouter|together\s+ai|groq|mistral\s+ai|deepseek|minimax|azure\s+openai|aws\s+bedrock|vertex\s+ai|google\s+ai)\b/i,
  /\b(?:i am|i'm|my model is|this assistant is|powered by|built (?:with|by)|running on|based on)\s+(?:the\s+)?(?:chatgpt|claude|gemini|llama|mixtral|qwen|grok)\b/i,
  /\b(?:mình|tôi|minh|toi)\s+(?:là|la|chạy trên|chay tren|đang chạy trên|dang chay tren|dùng|dung|đang dùng|dang dung)\s+(?:chatgpt|claude|gemini|llama|mixtral|qwen|grok)\b/i,
  /\bgpt\b/i,
  /\bgpt[-_\s]?\d/i,
  /\bclaude[-_\s]?\d/i,
  // Hyphenated model families only — bare "o3" collides with IELTS essay text (ozone, CO2).
  /\bo[134]-(?:mini|preview|pro)\b/i,
  /\bsystem\s*fingerprint\b/i,
  /\bknowledge\s+cutoff\b/i,
  /\btemperature\s*[:=]\s*\d/i,
  /\btop[_-]?p\s*[:=]/i,
];

export type HarmfulOutputSafetyReason =
  | 'self_harm_instruction'
  | 'targeted_harassment';

/**
 * Bounded output-side patterns for actionable self-harm instructions. This is
 * deliberately narrower than the input crisis classifier: prevention,
 * translation, quoted analysis, and fictional discussion must remain usable.
 */
const SELF_HARM_INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /\b(?:how|ways?|steps?|instructions?)\s+(?:to|for)\s+(?:self[-\s]?harm|harm\s+(?:my|your)self)\b/i,
  /\b(?:how|ways?|steps?|instructions?)\s+(?:to|for)\s+commit\s+suicide\b/i,
  /\b(?:how(?:\s+(?:do|can)\s+i)?|what\s+is\s+the\s+(?:most\s+)?(?:effective|quickest|best)\s+way|(?:tell|show)\s+me\s+how|(?:give|provide)\s+(?:me\s+)?(?:instructions?|steps?)|instructions?\s+(?:for|to)|steps?\s+to|ways?\s+to)\b(?:(?!\b(?:prevent(?:ion|ing)?|avoid(?:ing)?|stop(?:ping)?|reduce|support|help|protect|safety|safe|warning|education|awareness|treatment|recovery|hotline|intervention|not|never|don't|do\s+not)\b).){0,100}\b(?:kill\s+(?:my|your)self|take\s+(?:my|your)\s+life|cut\s+(?:my|your)self|overdose(?:\s+on)?|hang\s+(?:my|your)self|jump\s+off\s+(?:a|the)\s+(?:bridge|building|roof))\b/i,
  /(?:chi minh|huong dan|cach|lam sao|lam the nao|phuong phap)(?![^.!?\n]{0,40}(?:phong ngua|ngan chan|ngan ngua|ho tro|giup|tuyen truyen))[^.!?\n]{0,100}(?:cat\s+(?:co tay|tay)|uong\s+thuoc\s+qua\s+lieu|nhay\s+(?:lau|cau)|tu\s+(?:sat|tu))/i,
  /(?:怎么|如何|怎样|教我|指导|方法)(?![^。！？\n]{0,20}(?:预防|防止|避免|支持|帮助|热线|宣传))[^。！？\n]{0,40}(?:割腕|自杀|自残|跳楼|跳桥|过量服药|上吊)/u,
  /\b(?:you should|you must|go ahead and|just|it's okay to|please)\s+(?!not\b|never\b|don't\b|do\s+not\b)(?:kill yourself|harm yourself|cut yourself|take your life|end your life|commit suicide|overdose|hang yourself|jump off (?:a|the) (?:bridge|building|roof))\b/i,
  /(?:hay|ban nen|ban phai|cu|di|phai|nen)\s+(?:tu tu|tu sat|tu hai|cat tay|cat co tay|nhay lau|nhay cau)(?:\s+di)?\b/i,
  /(?:你应该|你必须|去|赶紧|就去)\s*(?:自杀|自残|割腕|跳楼|跳桥|上吊)/u,
];

/**
 * Targeted harassment requires both a harmful action and an identifiable
 * person/target cue. Generic insults, frustration, and constructive critique
 * are intentionally outside this guard.
 */
const TARGETED_HARASSMENT_PATTERNS: readonly RegExp[] = [
  /(?:write|generate|draft|compose|create).{0,100}(?:smear\s+campaign|defam(?:e|ation)|harass(?:ing|ment)?|humiliat(?:e|ing)|insults?|threat(?:en(?:ing)?)?|doxx(?:ing)?|ridicul(?:e|ing)?|mock(?:ing)?).{0,100}(?:about|against|at|to|on|accusing|targeting|john|someone|somebody|him|her|them)\b/i,
  /(?:how\s+(?:do|can)\s+i|(?:give|provide)\s+(?:me\s+)?(?:instructions?|steps?)|instructions?\s+(?:for|to)|steps?\s+to).{0,100}(?:doxx|harass|threaten).{0,100}(?:someone|somebody|a\s+person|him|her|them|phone|number)\b/i,
  /(?:viet|soan|lap).{0,100}(?:chui|ha nhuc|xuc pham|boi nho|quay roi|de doa|lang ma).{0,100}(?:thang|con|ong|ba|co|anh|chi|ban|nguoi|ten|lan)\b/i,
  /(?:huong dan|cach).{0,100}(?:doxx|quay roi|de doa|boi nho|xuc pham).{0,100}(?:nguoi|so dien thoai|thang|con|anh|chi|ban)\b/i,
  /(?:写|生成|编写|帮我写|起草).{0,100}(?:造谣|诽谤|侮辱|骚扰|威胁|辱骂).{0,100}(?:李华|某人|别人|他|她|同学|老师)/u,
  /(?:教我|怎么|如何).{0,100}(?:人肉搜索|恶意轰炸|造谣|诽谤|骚扰).{0,100}(?:别人|某人|他|她|同学|老师|手机号码)/u,
  /(?:harass|humiliat|insult|threaten|defam|doxx|smear|ridicul|mock|abuse).{0,80}(?:him|her|them)\b/i,
  /(?:him|her|them).{0,80}(?:harass|humiliat|insult|threaten|defam|doxx|smear|ridicul|mock|abuse)\b/i,
  /\b(?!(?:You|This|That|Someone|Somebody|Anyone|Everyone|Everybody|Nobody|He|She|They|We|It|The|A|An|My|Your|Our|Their|His|Her|These|Those|Please|Write|Generate)\b)[A-Z][a-z]{1,30}\b.{0,80}(?:idiot|stupid|disgusting|loser|scum|worthless|piece\s+of\s+shit)\b/,
  /\b(?:[Hh]arass|[Hh]umiliat|[Ii]nsult|[Tt]hreaten|[Dd]efam|[Dd]oxx|[Ss]mear|[Rr]idicul|[Mm]ock|[Aa]buse).{0,80}\b[A-Z][a-z]{1,30}\b/,
  /(?:chui|ha nhuc|xuc pham|boi nho|quay roi|de doa|lang ma).{0,80}\b(?:thang|con|ong|ba|anh|chi|ten|lan)\b/i,
  /\b(?:thang|con|ong|ba|anh|chi|ban|ten|lan)\b.{0,80}(?:chui|ha nhuc|xuc pham|boi nho|quay roi|de doa|lang ma|ngu|rac ruoi|ngoc|do te)\b/i,
  /(?:辱骂|侮辱|骚扰|威胁|诽谤).{0,40}(?:李华|某人|他|她|同学|老师)/u,
  /(?:李华|某人|他|她|同学|老师).{0,40}(?:辱骂|侮辱|骚扰|威胁|诽谤|废物|蠢货|垃圾|笨蛋)/u,
];

const TARGETED_HARASSMENT_CONTEXT_PATTERNS: readonly RegExp[] = [
  /\b(?:fiction(?:al)?|literary|literature|character|quoted?|quote|analysis|analy[sz]e|example|academic|constructive|criticism|critique|feedback|respectful|essay|discussion)\b/i,
  /(?:nhan vat|van hoc|trich dan|trich|phan tich|vi du|hoc thuat|xay dung|gop y|ton trong|bai luan)/i,
  /(?:虚构|小说|文学|角色|引用|引文|分析|例子|学术|建设性|批评|反馈|尊重|讨论)/u,
];

const TARGETED_HARASSMENT_ACTION_MARKERS: readonly RegExp[] = [
  /\b(?:harass|humiliat|insult|threaten|defam|doxx|smear|ridicul|mock|abuse)\w*\b/i,
  /(?:chui|ha nhuc|xuc pham|boi nho|quay roi|de doa|lang ma)/i,
  /(?:辱骂|侮辱|骚扰|威胁|诽谤|人肉搜索|恶意轰炸)/u,
];

function isTargetedHarassmentCandidate(candidate: string): boolean {
  if (
    !TARGETED_HARASSMENT_PATTERNS.some((pattern) => pattern.test(candidate))
  ) {
    return false;
  }

  // Quoted/fictional/academic descriptions of a named person can contain an
  // insult without being a direct attack. Explicit harassment actions still
  // win over the context marker.
  return (
    !TARGETED_HARASSMENT_CONTEXT_PATTERNS.some((pattern) =>
      pattern.test(candidate),
    ) ||
    TARGETED_HARASSMENT_ACTION_MARKERS.some((pattern) =>
      pattern.test(candidate),
    )
  );
}

export interface FinalOutputSafetyResult {
  unsafe: boolean;
  reason?:
    | 'prompt_leak'
    | 'credential_leak'
    | 'vendor_leak'
    | HarmfulOutputSafetyReason;
}

export function isHarmfulOutputSafetyReason(
  reason: string | undefined,
): reason is HarmfulOutputSafetyReason {
  return reason === 'self_harm_instruction' || reason === 'targeted_harassment';
}

function compactCanonicalText(text: string): string {
  // ponytail: compact only long allowlisted markers; add short-token spacing
  // rules only after a reproduced bypass to avoid false positives.
  return text.replace(/[^\p{L}\p{N}]+/gu, '');
}

function containsPromptLeakMarker(outputCandidates: string[]): boolean {
  const canonicalOutputCandidates = outputCandidates.slice(1);

  return SYSTEM_PROMPT_LEAK_MARKERS.some((marker) => {
    const markerCandidates = buildSafetyScanCandidates(marker).slice(1);
    return markerCandidates.some((markerCandidate) => {
      const compactMarker = compactCanonicalText(markerCandidate);
      return canonicalOutputCandidates.some(
        (candidate) =>
          candidate.includes(markerCandidate) ||
          compactCanonicalText(candidate).includes(compactMarker),
      );
    });
  });
}

export function checkFinalOutputSafety(text: string): FinalOutputSafetyResult {
  const outputCandidates = buildSafetyScanCandidates(text);

  if (containsPromptLeakMarker(outputCandidates)) {
    return { unsafe: true, reason: 'prompt_leak' };
  }
  for (const pattern of CREDENTIAL_SHAPES) {
    if (pattern.test(text)) {
      return { unsafe: true, reason: 'credential_leak' };
    }
  }
  for (const pattern of VENDOR_MODEL_PATTERNS) {
    if (outputCandidates.some((candidate) => pattern.test(candidate))) {
      return { unsafe: true, reason: 'vendor_leak' };
    }
  }
  if (
    SELF_HARM_INSTRUCTION_PATTERNS.some((pattern) =>
      outputCandidates.some((candidate) => pattern.test(candidate)),
    )
  ) {
    return { unsafe: true, reason: 'self_harm_instruction' };
  }
  if (
    outputCandidates.some((candidate) =>
      isTargetedHarassmentCandidate(candidate),
    )
  ) {
    return { unsafe: true, reason: 'targeted_harassment' };
  }
  return { unsafe: false };
}
