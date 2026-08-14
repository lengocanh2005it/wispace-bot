import {
  DiscordPendingJoinService,
  PENDING_LINK_COOKIE_NAME,
  PENDING_LINK_TTL_MS,
} from './discord-pending-join.service';

describe('DiscordPendingJoinService', () => {
  it('issues a cookie-name capability with a 15-minute TTL', () => {
    const service = new DiscordPendingJoinService();
    const token = service.create('discord-user-1', 143, 'TestUser');

    expect(token).toBeTruthy();
    expect(PENDING_LINK_COOKIE_NAME).toBe('pending_link');
    expect(PENDING_LINK_TTL_MS).toBe(15 * 60 * 1000);
  });

  it('consume returns the entry exactly once and rejects replay', () => {
    const service = new DiscordPendingJoinService();
    const token = service.create('discord-user-1', 143, 'TestUser');

    expect(service.consume(token)).toMatchObject({ wispaceUserId: 143 });
    expect(service.consume(token)).toBeUndefined();
    expect(service.get(token)).toBeUndefined();
  });

  it('consume rejects an expired capability', () => {
    const service = new DiscordPendingJoinService();
    const token = service.create('discord-user-1', 143, 'TestUser');
    const entry = service.get(token);

    expect(entry).toBeDefined();
    if (entry) {
      entry.expiresAt = Date.now() - 1000;
    }

    expect(service.consume(token)).toBeUndefined();
  });

  it('get returns entry when not yet expired', () => {
    const service = new DiscordPendingJoinService();
    const token = service.create('discord-user-1', 143, 'TestUser');
    const entry = service.get(token);

    expect(entry).toBeDefined();
    expect(entry?.wispaceUserId).toBe(143);
  });

  it('get returns undefined after expiry', () => {
    const service = new DiscordPendingJoinService();
    const token = service.create('discord-user-1', 143, 'TestUser');
    const entry = service.get(token);

    expect(entry).toBeDefined();
    if (entry) {
      entry.expiresAt = Date.now() - 1000;
    }

    expect(service.get(token)).toBeUndefined();
  });
});
