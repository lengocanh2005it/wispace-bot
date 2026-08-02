import {
  CanActivate,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

export const INTERNAL_API_KEY_HEADER = 'x-internal-api-key';

@Injectable()
export class InternalApiKeyGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.configService.get<string>('INTERNAL_API_KEY')?.trim();

    if (!expected) {
      throw new InternalServerErrorException(
        'INTERNAL_API_KEY must be set in .env',
      );
    }

    const request = context.switchToHttp().getRequest<Request>();
    const provided = this.extractApiKey(request);

    if (!provided || provided !== expected) {
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
