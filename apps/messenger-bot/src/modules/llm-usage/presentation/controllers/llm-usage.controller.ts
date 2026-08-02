import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { InternalApiKeyGuard } from '@wispace/bot-common';
import { LlmUsageQueryService } from '../../application/services/llm-usage-query.service';

@Controller('messenger/ops/llm-usage')
@UseGuards(InternalApiKeyGuard)
export class LlmUsageController {
  constructor(private readonly queryService: LlmUsageQueryService) {}

  @Get('summary')
  getUserSummary(
    @Query('psid') psid?: string,
    @Query('userId') userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const parsedUserId =
      userId !== undefined && userId !== '' ? Number(userId) : undefined;

    return this.queryService.getUserSummary({
      psid,
      userId: Number.isFinite(parsedUserId) ? parsedUserId : undefined,
      from,
      to,
    });
  }

  @Get('fleet')
  getFleetSummary(@Query('date') date?: string) {
    return this.queryService.getFleetSummary({ date });
  }
}
