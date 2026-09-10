import { readFileSync } from 'fs';
import { resolvePromptPath } from './eval/eval-harness';

/**
 * Overlay drift guard (#648): a core rule copied into a per-bot overlay
 * must fail CI. Markers are stable substrings of rules that canonically live
 * in CHAT_SYSTEM_PROMPT_CORE — if one shows up in an overlay, the copy
 * returned. Rewording a canonical rule means updating its marker here
 * deliberately.
 */
const OVERLAY_PATHS = [
  'apps/messenger-bot/src/shared/prompts/messenger-chat.system.txt',
  'apps/discord-bot/src/shared/prompts/discord-chat.system.txt',
  'apps/zalo-bot/src/shared/prompts/zalo-chat.system.txt',
];

const CORE_RULE_MARKERS = [
  'do not call get_upcoming_study_sessions in the same',
  'reply warmly only',
  'bạn là ai',
  'gian lận học thuật',
];

describe.each(OVERLAY_PATHS)('overlay drift guard (#648): %s', (path) => {
  const overlay = readFileSync(resolvePromptPath(path), 'utf8').replace(
    /\r\n/g,
    '\n',
  );

  it.each(CORE_RULE_MARKERS)(
    'does not copy the core rule containing %j',
    (marker) => {
      expect(overlay.toLowerCase()).not.toContain(marker.toLowerCase());
    },
  );
});

/**
 * Message-format coverage (#991): the format rule moved out of the core into
 * the overlays, so every overlay must state the format its platform renders.
 * An overlay that says nothing leaves the model to guess.
 */
const OVERLAY_FORMAT_RULES: Array<[string, string]> = [
  [
    'apps/messenger-bot/src/shared/prompts/messenger-chat.system.txt',
    'Plain text only',
  ],
  ['apps/zalo-bot/src/shared/prompts/zalo-chat.system.txt', 'Plain text only'],
  [
    'apps/discord-bot/src/shared/prompts/discord-chat.system.txt',
    'Discord renders Markdown',
  ],
];

describe.each(OVERLAY_FORMAT_RULES)(
  'overlay states its message format (#991): %s',
  (path, rule) => {
    it(`contains ${JSON.stringify(rule)}`, () => {
      const overlay = readFileSync(resolvePromptPath(path), 'utf8');
      expect(overlay).toContain(rule);
    });
  },
);
