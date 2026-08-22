import { Injectable, Logger } from '@nestjs/common';
import { maskExternalId } from '@wispace/bot-common';
import type { PrivacyIntent } from './privacy-intent.utils';

/**
 * In-memory state for pending privacy actions.
 * Tracks users who have initiated but not yet confirmed a privacy action.
 *
 * TTL: 5 minutes — if the user doesn't confirm/cancel within this window,
 * the pending action is cleared automatically.
 */

interface PendingPrivacyAction {
  intent: PrivacyIntent;
  psid: string;
  platform: string;
  createdAt: number;
}

const PENDING_ACTION_TTL_MS = 5 * 60 * 1000; // 5 minutes

@Injectable()
export class PrivacyStateService {
  private readonly logger = new Logger(PrivacyStateService.name);
  private readonly pendingActions = new Map<string, PendingPrivacyAction>();

  /**
   * Store a pending privacy action for a user.
   * Returns the confirm message to send.
   */
  setPendingAction(
    psid: string,
    platform: string,
    intent: PrivacyIntent,
  ): string {
    const key = this.getKey(psid, platform);
    this.pendingActions.set(key, {
      intent,
      psid,
      platform,
      createdAt: Date.now(),
    });

    return this.getConfirmMessage(intent);
  }

  /**
   * Get the pending privacy action for a user.
   * Returns null if no action is pending or if it has expired.
   */
  getPendingAction(psid: string, platform: string): PrivacyIntent | null {
    const key = this.getKey(psid, platform);
    const action = this.pendingActions.get(key);

    if (!action) {
      return null;
    }

    // Check TTL
    if (Date.now() - action.createdAt > PENDING_ACTION_TTL_MS) {
      this.logger.log(
        `Pending privacy action expired for psid=${maskExternalId(psid)}`,
      );
      this.pendingActions.delete(key);
      return null;
    }

    return action.intent;
  }

  /**
   * Clear the pending privacy action for a user.
   * Called after confirm/cancel/expiry.
   */
  clearPendingAction(psid: string, platform: string): void {
    const key = this.getKey(psid, platform);
    this.pendingActions.delete(key);
  }

  private getKey(psid: string, platform: string): string {
    return `${platform}:${psid}`;
  }

  private getConfirmMessage(intent: PrivacyIntent): string {
    switch (intent) {
      case 'unlink':
        return (
          'Bạn có chắc muốn ngắt kết nối tài khoản?\n\n' +
          'Hành động này sẽ:\n' +
          '- Xóa liên kết giữa Messenger và WISPACE\n' +
          '- Hủy tất cả nhắc lịch học\n' +
          '- Xóa dữ liệu học tập cá nhân\n\n' +
          'Reply "Có" để xác nhận hoặc "Không" để hủy.'
        );
      case 'delete':
        return (
          'Bạn có chắc muốn xóa toàn bộ dữ liệu?\n\n' +
          'Hành động này sẽ:\n' +
          '- Xóa liên kết tài khoản\n' +
          '- Xóa tất cả dữ liệu học tập\n' +
          '- Xóa lịch sử chat\n' +
          '- Không thể hoàn tác\n\n' +
          'Reply "Có" để xác nhận hoặc "Không" để hủy.'
        );
      case 'export':
        return (
          'Bạn có muốn tải về dữ liệu cá nhân?\n\n' +
          'Dữ liệu bao gồm:\n' +
          '- Thông tin liên kết tài khoản\n' +
          '- Dữ liệu học tập\n' +
          '- Thống kê sử dụng\n\n' +
          'Reply "Có" để xác nhận hoặc "Không" để hủy.'
        );
      default:
        return 'Bạn muốn thực hiện thao tác nào? Reply "Có" để xác nhận.';
    }
  }
}
