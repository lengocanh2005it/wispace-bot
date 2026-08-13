import { ZaloOauthModule } from '../zalo-oauth/zalo-oauth.module';
import { ZaloChatModule } from './zalo-chat.module';

describe('Zalo module boundaries', () => {
  it('keeps OAuth independent from chat while chat depends on OAuth', () => {
    const oauthImports = Reflect.getMetadata('imports', ZaloOauthModule) as
      | unknown[]
      | undefined;
    const chatImports = Reflect.getMetadata('imports', ZaloChatModule) as
      | unknown[]
      | undefined;

    expect(oauthImports ?? []).not.toContain(ZaloChatModule);
    expect(chatImports ?? []).toContain(ZaloOauthModule);
  });
});
