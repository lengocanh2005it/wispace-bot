import fc from 'fast-check';
import {
  isCancel,
  isContradictory,
  normalizeClarificationText,
  parseChoice,
  type ClarificationChoice,
} from './clarification-text';

fc.configureGlobal({ numRuns: 200 });

const CHOICES: ReadonlyArray<{
  alias: string;
  choice: ClarificationChoice;
}> = [
  { alias: '1', choice: 'progress' },
  { alias: 'lich hoc', choice: 'schedule' },
  { alias: 'doi lich', choice: 'reschedule' },
  { alias: 'the second one', choice: 'schedule' },
  { alias: 'cái thứ 3', choice: 'reschedule' },
];

const EXPLICIT_CHOICES: ReadonlyArray<{
  alias: string;
  choice: ClarificationChoice;
}> = [
  { alias: '1', choice: 'progress' },
  { alias: '2', choice: 'schedule' },
  { alias: '3', choice: 'reschedule' },
  { alias: 'first one', choice: 'progress' },
  { alias: 'second one', choice: 'schedule' },
  { alias: 'third one', choice: 'reschedule' },
];

describe('clarification text', () => {
  it('normalizes Vietnamese variants and accepts numbered choices', () => {
    expect(parseChoice('  Một  ')).toBe('progress');
    expect(parseChoice('lich hoc')).toBe('schedule');
    expect(parseChoice('ĐỔI LỊCH')).toBe('reschedule');
    expect(parseChoice('3')).toBe('reschedule');
    expect(parseChoice('the second one')).toBe('schedule');
    expect(parseChoice('cái thứ 3')).toBe('reschedule');
    expect(parseChoice('2 nhé')).toBe('schedule');
    expect(parseChoice('chon mot')).toBe('progress');
    expect(parseChoice('chon 2')).toBe('schedule');
    expect(parseChoice('option 3')).toBe('reschedule');
    expect(parseChoice('td')).toBe('progress');
    expect(parseChoice('lh')).toBe('schedule');
    expect(parseChoice('2nd')).toBe('schedule');
    expect(parseChoice('option 2 nha')).toBe('schedule');
    expect(parseChoice('lua chon 3 di')).toBe('reschedule');
    expect(parseChoice('the first one nhe')).toBe('progress');
  });

  it('recognizes explicit cancellation without treating it as a tool intent', () => {
    expect(isCancel('  huy  ')).toBe(true);
    expect(isCancel('bỏ qua')).toBe(true);
    expect(parseChoice('tiến độ')).toBe('progress');
  });

  it('treats contradictory choice batches as ambiguous', () => {
    expect(isContradictory('lịch học\n3')).toBe(true);
    expect(isContradictory('xem lịch học và đổi lịch học')).toBe(true);
    expect(isContradictory('tiến độ và lịch học')).toBe(true);
    expect(isContradictory('tiến độ, lịch học')).toBe(true);
    expect(isContradictory('1 1')).toBe(false);
    expect(isContradictory('mình muốn xem lịch học')).toBe(false);
    expect(isContradictory('mình muốn dời lịch')).toBe(false);
  });
});

describe('clarification text properties', () => {
  it('normalizes arbitrary text to a fixed point', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const normalized = normalizeClarificationText(text);

        expect(normalizeClarificationText(normalized)).toBe(normalized);
        expect(normalized).not.toMatch(/\s{2,}/);
      }),
    );
  });

  it('parses aliases with harmless boundary whitespace and punctuation', () => {
    fc.assert(
      fc.property(fc.constantFrom(...CHOICES), (entry) => {
        expect(parseChoice(`\n\t... ${entry.alias} !!!  `)).toBe(entry.choice);
      }),
    );
  });

  it('detects contradictory distinct choices but not repeated identical choices', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...EXPLICIT_CHOICES),
        fc.constantFrom(...EXPLICIT_CHOICES),
        (first, second) => {
          const sameChoice = first.choice === second.choice;
          const text = `${first.alias} and ${second.alias}`;

          expect(isContradictory(text)).toBe(!sameChoice);
        },
      ),
    );
  });
});
