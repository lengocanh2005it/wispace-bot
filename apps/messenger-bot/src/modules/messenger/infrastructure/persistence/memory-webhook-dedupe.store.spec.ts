import { MessengerChatSharedConfigService } from '../../application/services/messenger-chat-shared-config.service';
import { MemoryWebhookDedupeStore } from './memory-webhook-dedupe.store';

describe('MemoryWebhookDedupeStore', () => {
  const createStore = (retentionMs = 3_600_000) => {
    const sharedConfig = {
      getWebhookDedupeRetentionMs: () => retentionMs,
    } as MessengerChatSharedConfigService;

    return new MemoryWebhookDedupeStore(sharedConfig);
  };

  it('treats first message mid as new', async () => {
    const store = createStore();
    await expect(store.isDuplicateMessageMid('mid-1', 'psid-1')).resolves.toBe(
      false,
    );
  });

  it('treats repeated message mid as duplicate', async () => {
    const store = createStore();
    await store.isDuplicateMessageMid('mid-1', 'psid-1');
    await expect(store.isDuplicateMessageMid('mid-1', 'psid-1')).resolves.toBe(
      true,
    );
  });

  it('treats repeated postback as duplicate within 15s', async () => {
    const store = createStore();
    await store.isDuplicatePostback('psid-1', 'MENU_REPORT');
    await expect(
      store.isDuplicatePostback('psid-1', 'MENU_REPORT'),
    ).resolves.toBe(true);
  });

  it('re-processes a mid after forgetMessageMid (dead-letter replay path)', async () => {
    const store = createStore();
    await store.isDuplicateMessageMid('mid-1', 'psid-1');
    await store.forgetMessageMid('mid-1', 'psid-1');
    await expect(store.isDuplicateMessageMid('mid-1', 'psid-1')).resolves.toBe(
      false,
    );
  });
});
