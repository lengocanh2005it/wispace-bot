import { LlmSafetyCore } from './llm-safety-core.service';

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('LlmSafetyCore', () => {
  it('persists only redacted excerpts and hashes — never raw text (#122)', async () => {
    const insert = jest
      .fn<Promise<void>, [unknown]>()
      .mockResolvedValue(undefined);
    const core = new LlmSafetyCore({ insert } as never);

    core.recordGroundingWarning({
      externalUserId: 'ext-1',
      reason: 'unexpected_band',
      userTextPreview: 'Cho mình xem điểm với password: SuperSecret123!',
      assistantTextPreview: 'Band của bạn là 9.0 - dữ liệu lạ\u0000',
      toolNamesUsed: ['get_user_goals'],
    });
    await flushMicrotasks();

    expect(insert).toHaveBeenCalledTimes(1);
    const event = insert.mock.calls[0]?.[0] as {
      payload: Record<string, unknown>;
    };
    const payload = event.payload;

    expect(payload.toolNamesUsed).toEqual(['get_user_goals']);
    expect(payload.userTextExcerpt).toContain('[REDACTED]');
    expect(payload.userTextExcerpt).not.toContain('SuperSecret123');
    expect(payload.userTextHash).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.userTextLength).toBeGreaterThan(0);
    expect(payload.assistantTextExcerpt).not.toContain('\u0000');
    expect(payload.assistantTextHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('omits redacted fields when no text is provided', async () => {
    const insert = jest
      .fn<Promise<void>, [unknown]>()
      .mockResolvedValue(undefined);
    const core = new LlmSafetyCore({ insert } as never);

    core.recordGroundingWarning({
      externalUserId: 'ext-1',
      reason: 'no_tools',
      toolNamesUsed: [],
    });
    await flushMicrotasks();

    const event = insert.mock.calls[0]?.[0] as {
      payload: Record<string, unknown>;
    };
    expect(event.payload.userTextExcerpt).toBeUndefined();
    expect(event.payload.userTextHash).toBeUndefined();
    expect(event.payload.assistantTextExcerpt).toBeUndefined();
    expect(event.payload.toolNamesUsed).toEqual([]);
  });

  it('never throws when the repository insert fails (best-effort)', async () => {
    const insert = jest
      .fn<Promise<void>, [unknown]>()
      .mockRejectedValue(new Error('db down'));
    const warn = jest.fn();
    const core = new LlmSafetyCore({ insert } as never, {
      warn,
      log: jest.fn(),
    });

    expect(() =>
      core.recordGroundingWarning({
        externalUserId: 'ext-1',
        reason: 'x',
        userTextPreview: 'abc',
        toolNamesUsed: [],
      }),
    ).not.toThrow();
    await flushMicrotasks();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed'));
  });
});
