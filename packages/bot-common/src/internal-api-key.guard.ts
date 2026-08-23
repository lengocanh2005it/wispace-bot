import {
  CanActivate,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';

export const INTERNAL_API_KEY_HEADER = 'x-internal-api-key';

@Injectable()
export class InternalApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(InternalApiKeyGuard.name);

  constructor(private readonly configService: ConfigService) {}

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
      throw new UnauthorizedException('Invalid or missing internal API key');
    }

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid or missing internal API key');
    }

    return true;
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
