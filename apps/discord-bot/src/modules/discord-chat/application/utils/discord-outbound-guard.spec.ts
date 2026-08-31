import { prepareDiscordOutbound } from './discord-outbound-guard';

describe('prepareDiscordOutbound', () => {
  it('neutralizes actionable mentions without changing ordinary at-sign text', () => {
    const result = prepareDiscordOutbound(
      'Ping @everyone @here <@&123> <@123> <@!456> @alice a@b.com @everyone_team foo@everyone',
    );

    expect(result.content).toBe(
      'Ping [mọi người] [kênh này] [vai trò] [người dùng] [người dùng] @alice a@b.com @everyone_team foo@everyone',
    );
    expect(result.neutralized).toEqual({
      everyone: 1,
      here: 1,
      role: 1,
      user: 2,
    });
    expect(result.allowedMentions).toEqual({
      parse: [],
      roles: [],
      users: [],
      repliedUser: false,
    });
  });

  it('preserves only canonical user mentions in the trusted allowlist', () => {
    const result = prepareDiscordOutbound(
      '<@123> <@!456> <@789> <@&999> @EVERYONE',
      ['123', '123', 'not-a-snowflake'],
    );

    expect(result.content).toBe(
      '<@123> [người dùng] [người dùng] [vai trò] [mọi người]',
    );
    expect(result.neutralized).toEqual({
      everyone: 1,
      here: 0,
      role: 1,
      user: 2,
    });
    expect(result.allowedMentions).toEqual({
      parse: [],
      roles: [],
      users: ['123'],
      repliedUser: false,
    });
  });

  it('is idempotent after neutralization', () => {
    const once = prepareDiscordOutbound('@everyone <@&123> <@456>');
    const twice = prepareDiscordOutbound(once.content);

    expect(twice.content).toBe(once.content);
    expect(twice.neutralized).toEqual({
      everyone: 0,
      here: 0,
      role: 0,
      user: 0,
    });
  });
});
