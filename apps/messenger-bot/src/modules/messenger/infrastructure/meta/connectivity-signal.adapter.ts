import { Injectable } from '@nestjs/common';
import type { PlatformConnectivitySignalPort } from '../../application/ports/platform-connectivity-signal.port';
import { MessengerPlatformConnectivityService } from './messenger-platform-connectivity.service';

@Injectable()
export class MessengerConnectivitySignalAdapter implements PlatformConnectivitySignalPort {
  constructor(
    private readonly connectivity: MessengerPlatformConnectivityService,
  ) {}

  markTokenRejected(): void {
    this.connectivity.markTokenRejected();
  }

  markOutboundSuccess(): void {
    this.connectivity.markOutboundSuccess();
  }
}
