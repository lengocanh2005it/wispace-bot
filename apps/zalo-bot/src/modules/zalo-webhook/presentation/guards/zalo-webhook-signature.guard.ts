import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import {
  isZaloWebhookTimestampFresh,
  verifyZaloWebhookSignature,
} from '../../application/utils/zalo-webhook-signature.utils';
import type { ZaloWebhookEvent } from '../../domain/entities/zalo-webhook-event.types';

type ZaloWebhookRequest = Omit<Request, 'body'> & {
  rawBody?: Buffer;
  body: ZaloWebhookEvent;
};

@Injectable()
export class ZaloWebhookSignatureGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<ZaloWebhookRequest>();
    const appId = this.configService.getOrThrow<string>('ZALO_APP_ID');
    const appSecretKey = this.configService.getOrThrow<string>(
      'ZALO_APP_SECRET_KEY',
    );
    const rawBody =
      request.rawBody?.toString('utf8') ?? JSON.stringify(request.body);
    const timestamp =
      request.header('x-zevent-timestamp') ?? request.body.timestamp;
    const signatureHeader = request.header('x-zevent-signature');

    if (
      !timestamp ||
      !verifyZaloWebhookSignature({
        appId,
        rawBody,
        timestamp,
        appSecretKey,
        signatureHeader,
      })
    ) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    if (!isZaloWebhookTimestampFresh(timestamp)) {
      throw new UnauthorizedException('Stale webhook timestamp');
    }

    return true;
  }
}
