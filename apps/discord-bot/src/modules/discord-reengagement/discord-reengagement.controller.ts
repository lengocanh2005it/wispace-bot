import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { IsInt, IsPositive } from 'class-validator';
import { InternalApiKeyGuard } from '@wispace/bot-common/guard';
import type { ReengagementRunOnceResult } from './discord-reengagement.service';
import { DiscordReengagementService } from './discord-reengagement.service';

class RunOnceBody {
  @IsInt()
  @IsPositive()
  userId!: number;
}

/**
 * Manual re-engagement trigger (FAQ #4: test a user without waiting 11 days)
 * — permanent ops tool. Dormancy gate does not apply here (see service).
 */
@Controller('discord')
@UseGuards(InternalApiKeyGuard, ThrottlerGuard)
export class DiscordReengagementController {
  constructor(private readonly reengagement: DiscordReengagementService) {}

  @Post('reengagement/run-once')
  @HttpCode(HttpStatus.OK)
  async runOnce(
    @Body() body?: RunOnceBody,
  ): Promise<ReengagementRunOnceResult> {
    // Defensive re-check: the global ValidationPipe enforces the decorators,
    // direct callers (tests/ops scripts) go through this check.
    const userId = Number(body?.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new HttpException(
        'userId must be a positive integer',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.reengagement.runOnce(userId);
  }
}
