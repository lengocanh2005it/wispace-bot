import {
  POC_DEFAULT_LINK_CADENCE,
  POC_DEFAULT_LINK_TOPIC,
  parseMessengerLinkContext,
} from './poc.constants';

describe('parseMessengerLinkContext', () => {
  it('accepts ref-only with POC defaults (Messenger Get Started)', () => {
    expect(parseMessengerLinkContext({ ref: '143' })).toEqual({
      ref: '143',
      userId: 143,
      topic: POC_DEFAULT_LINK_TOPIC,
      cadence: POC_DEFAULT_LINK_CADENCE,
    });
  });

  it('keeps explicit topic and cadence from m.me link', () => {
    expect(
      parseMessengerLinkContext({
        ref: '143',
        topic: 'ai_capacity_report',
        cadence: 'DAILY',
      }),
    ).toEqual({
      ref: '143',
      userId: 143,
      topic: 'ai_capacity_report',
      cadence: 'DAILY',
    });
  });

  it('rejects invalid ref', () => {
    expect(parseMessengerLinkContext({ ref: 'abc' })).toBeUndefined();
  });
});
