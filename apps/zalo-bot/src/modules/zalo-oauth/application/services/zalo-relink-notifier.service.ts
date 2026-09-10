import { Inject, Injectable, Logger } from '@nestjs/common';
import { maskExternalId } from '@wispace/bot-common/masking';
import {
  ZALO_OUTBOUND,
  type ZaloOutboundPort,
} from '@zalo/modules/zalo-chat/application/ports/zalo-outbound.port';

@Injectable()
export class ZaloRelinkNotifier {
  private readonly logger = new Logger(ZaloRelinkNotifier.name);

  constructor(
    @Inject(ZALO_OUTBOUND) private readonly outbound: ZaloOutboundPort,
  ) {}

  async notify(zaloUserId: string, userId: number): Promise<void> {
    await this.outbound.sendText(
      zaloUserId,
      'Tài khoản Zalo của bạn vừa được liên kết lại với WISPACE thành công nhé! 🎉',
      { userId },
    );
    this.logger.debug(
      `Zalo relink notice sent for zaloUserId=${maskExternalId(zaloUserId)}`,
    );
  }
}
