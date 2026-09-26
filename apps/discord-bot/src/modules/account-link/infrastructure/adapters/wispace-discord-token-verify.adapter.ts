import { Injectable } from '@nestjs/common';
import { WispaceTokenVerifyService } from '@wispace/wispace-client/adapters';
import type { DiscordTokenVerifyPort } from '../../application/ports/discord-token-verify.port';

@Injectable()
export class WispaceDiscordTokenVerifyAdapter implements DiscordTokenVerifyPort {
  constructor(private readonly tokenVerifyService: WispaceTokenVerifyService) {}

  verifyToken(token: string, discordUserId: string) {
    return this.tokenVerifyService.verifyToken(token, discordUserId);
  }
}
