import { Injectable, Logger } from '@nestjs/common';
import { maskExternalId } from '@wispace/bot-common/masking';
import type { PrivacyIntent } from './privacy-intent.utils';

/**
 * In-memory state for pending privacy actions.
 * Tracks users who have initiated but not yet confirmed a privacy action.
 *
 * TTL: `ttlMs` (default 30 minutes) — if the user doesn't confirm/cancel
 * within this window, the pending action is cleared automatically. A reply
 * that arrives after expiry falls through to the normal chat pipeline.
 *
 * ponytail: in-memory, pod-local. A wider grace window is enough for the
 * current single-instance deployment; durable + cross-pod persistence is #542.
 */

interface PendingPrivacyAction {
  intent: PrivacyIntent;
  psid: string;
  platform: string;
  createdAt: number;
}

const DEFAULT_PENDING_ACTION_TTL_MS = 30 * 60 * 1000; // 30 minutes

@Injectable()
export class PrivacyStateService {
  private readonly logger = new Logger(PrivacyStateService.name);
  private readonly pendingActions = new Map<string, PendingPrivacyAction>();
  private readonly ttlMs: number;

  constructor(ttlMs?: number) {
    this.ttlMs =
      typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0
        ? Math.floor(ttlMs)
        : DEFAULT_PENDING_ACTION_TTL_MS;
  }

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
    if (Date.now() - action.createdAt > this.ttlMs) {
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
