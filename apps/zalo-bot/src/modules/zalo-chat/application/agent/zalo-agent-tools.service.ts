import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isAgentToolName } from '@wispace/llm-agent';
import type { ZaloAgentToolContext } from '../../domain/entities/zalo-chat.types';

const NOT_BUILT_YET_MESSAGE =
  'Tính năng này đang được phát triển cho Zalo — bạn dùng WISPACE qua Messenger/Discord cho việc này nhé.';

/**
 * MVP stub — implements ToolExecutorPort<ZaloAgentToolContext> from
 * @wispace/llm-agent but every AGENT_TOOLS entry is unavailable, whether or
 * not the account is linked. Real tool wiring (get_user_goals, calendar,
 * reschedule...) is future work — see spec §11.1.
 */
@Injectable()
export class ZaloAgentToolsService {
  private readonly oauthAuthorizeUrl: string;

  constructor(private readonly configService: ConfigService) {
    const appId = this.configService.get<string>('ZALO_APP_ID');
    const redirectUri = this.configService.get<string>(
      'ZALO_OAUTH_REDIRECT_URI',
    );
    this.oauthAuthorizeUrl =
      appId && redirectUri
        ? `https://oauth.zaloapp.com/v4/permission?app_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}`
        : '';
  }

  execute(
    toolName: string,
    _argsJson: string,
    ctx: ZaloAgentToolContext,
  ): Promise<unknown> {
    if (!isAgentToolName(toolName)) {
      return Promise.resolve({ error: `Unknown tool: ${toolName}` });
    }

    if (!ctx.userId) {
      const linkPart = this.oauthAuthorizeUrl
        ? `\n\nLiên kết tài khoản tại đây: ${this.oauthAuthorizeUrl}`
        : '';
      return Promise.resolve({
        available: false,
        message: `Bạn chưa liên kết tài khoản WISPACE với Zalo.${linkPart}`,
      });
    }

    return Promise.resolve({
      available: false,
      message: NOT_BUILT_YET_MESSAGE,
    });
  }
}
