import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';

export const INTERNAL_API_KEY_HEADER = 'x-internal-api-key';

/**
 * Optional port the guard uses to report 401 rejections (missing/invalid key).
 * bot-metrics provides the adapter via INTERNAL_AUTH_METRICS_PORT; without a
 * provider the guard still rejects — the counter is observability only.
 */
export const INTERNAL_AUTH_METRICS_PORT = Symbol('INTERNAL_AUTH_METRICS_PORT');

export interface InternalAuthMetricsPort {
  incRejected(): void;
}

@Injectable()
export class InternalApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(InternalApiKeyGuard.name);

  constructor(
    private readonly configService: ConfigService,
    @Optional()
    @Inject(INTERNAL_AUTH_METRICS_PORT)
    private readonly authMetrics?: InternalAuthMetricsPort,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.configService.get<string>('INTERNAL_API_KEY')?.trim();

    if (!expected) {
      this.logger.error(
        'INTERNAL_API_KEY is not configured — guarded routes will reject all requests',
      );
      throw new InternalServerErrorException(
        'Internal authentication not configured',
      );
    }

    const request = context.switchToHttp().getRequest<Request>();
    const provided = this.extractApiKey(request);

    if (!provided) {
      this.rejectUnauthorized();
    }

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      this.rejectUnauthorized();
    }

    return true;
  }

  /** Count the 401 and reject — the counter is observability only. */
  private rejectUnauthorized(): never {
    this.authMetrics?.incRejected();
    throw new UnauthorizedException('Invalid or missing internal API key');
  }

  private extractApiKey(request: Request): string | undefined {
    const headerKey = request.header(INTERNAL_API_KEY_HEADER)?.trim();
    if (headerKey) {
      return headerKey;
    }

    const auth = request.header('authorization')?.trim();
    if (auth?.toLowerCase().startsWith('bearer ')) {
      return auth.slice('bearer '.length).trim();
    }

    return undefined;
  }
}
