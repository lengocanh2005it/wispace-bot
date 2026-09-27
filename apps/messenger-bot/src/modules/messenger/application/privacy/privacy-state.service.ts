import { Injectable, Logger } from '@nestjs/common';
import { maskExternalId } from '@wispace/bot-common/masking';
import type { PrivacyAction, PrivacyIntent } from './privacy-intent.utils';

/**
 * In-memory state for pending privacy actions.
 * Tracks users who have initiated but not yet confirmed a privacy action.
 *
 * TTL: `ttlMs` (default 30 minutes) — if the user doesn't confirm/cancel
 * within this window, the next reply clears the pending action and falls
 * through to the normal chat pipeline.
 *
 * ponytail: in-memory, pod-local. A wider grace window is enough for the
 * current single-instance deployment; durable + cross-pod persistence is #542.
 */

/**
 * Identity snapshot taken when the action was armed. A pending action can
 * only be confirmed while the mapping still matches this snapshot — a
 * relink (same or different learner) invalidates it.
 */
export interface PrivacyIdentity {
  userId?: number;
  mappingGeneration?: string;
}

interface PendingPrivacyAction {
  intent: PrivacyAction;
  psid: string;
  platform: string;
  identityKey: string;
  createdAt: number;
}

const DEFAULT_PENDING_ACTION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_PENDING_ACTIONS = 10_000;

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
    intent: PrivacyAction,
    identity?: PrivacyIdentity,
  ): string {
    const key = this.getKey(psid, platform);
    if (
      !this.pendingActions.has(key) &&
      this.pendingActions.size >= MAX_PENDING_ACTIONS
    ) {
      const oldestKey = this.pendingActions.keys().next().value;
      if (oldestKey !== undefined) {
        this.pendingActions.delete(oldestKey);
      }
    }

    this.pendingActions.set(key, {
      intent,
      psid,
      platform,
      identityKey: PrivacyStateService.identityKeyOf(identity),
      createdAt: Date.now(),
    });

    return this.getConfirmMessage(intent);
  }

  /**
   * Get the pending privacy action for a user.
   * Returns null if no action is pending, the mapping identity changed
   * since the action was armed, or the action has expired.
   * Calling without `identity` peeks without the identity check.
   */
  getPendingAction(
    psid: string,
    platform: string,
    identity?: PrivacyIdentity,
  ): PrivacyIntent | null {
    const key = this.getKey(psid, platform);
    const action = this.pendingActions.get(key);

    if (!action) {
      return null;
    }

    if (
      identity !== undefined &&
      action.identityKey !== PrivacyStateService.identityKeyOf(identity)
    ) {
      this.pendingActions.delete(key);
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

  private static identityKeyOf(identity?: PrivacyIdentity): string {
    const userId = identity?.userId;
    const generation = identity?.mappingGeneration;
    if (userId === undefined && generation === undefined) return '-';
    return `${userId ?? '-'}:${generation ?? '-'}`;
  }

  private getConfirmMessage(intent: PrivacyAction): string {
    switch (intent) {
      case 'unlink':
        return (
          'Bạn có chắc muốn ngắt kết nối tài khoản?\n\n' +
          'Hành động này sẽ:\n' +
          '- Xóa liên kết giữa Messenger và WISPACE\n' +
          '- Hủy tất cả nhắc lịch học\n' +
          '- Xóa dữ liệu học tập cá nhân\n\n' +
          'Reply "Đồng ý ngắt kết nối" để xác nhận hoặc "Không" để hủy.'
        );
      case 'delete':
        return (
          'Bạn có chắc muốn xóa toàn bộ dữ liệu?\n\n' +
          'Hành động này sẽ:\n' +
          '- Xóa liên kết tài khoản\n' +
          '- Xóa tất cả dữ liệu học tập\n' +
          '- Xóa lịch sử chat\n' +
          '- Không thể hoàn tác\n\n' +
          'Reply "Đồng ý xóa dữ liệu" để xác nhận hoặc "Không" để hủy.'
        );
      case 'export':
        return (
          'Bạn có muốn tải về dữ liệu cá nhân?\n\n' +
          'Dữ liệu bao gồm:\n' +
          '- Thông tin liên kết tài khoản\n' +
          '- Dữ liệu học tập\n' +
          '- Thống kê sử dụng\n\n' +
          'Reply "Đồng ý tải dữ liệu" để xác nhận hoặc "Không" để hủy.'
        );
      default:
        throw new Error(`Unsupported privacy intent: ${intent}`);
    }
  }
}
