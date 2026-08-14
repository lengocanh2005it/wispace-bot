import type { Request, Response } from 'express';
import {
  PENDING_LINK_COOKIE_NAME,
  PENDING_LINK_TTL_MS,
} from '../../application/services/discord-pending-join.service';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'none' as const,
  path: '/',
};

/**
 * The pending-link capability is a browser-bound, server-side one-time state:
 * it lives in an HttpOnly cookie on the bot domain, never in URL query params,
 * browser history, or referrer headers. `SameSite=None` keeps it working for
 * the cross-origin WISPACE frontend; `Secure` + `HttpOnly` restrict exposure.
 */
export function readPendingLinkCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === PENDING_LINK_COOKIE_NAME) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }

  return undefined;
}

export function setPendingLinkCookie(res: Response, token: string): void {
  res.cookie(PENDING_LINK_COOKIE_NAME, token, {
    ...COOKIE_OPTIONS,
    maxAge: PENDING_LINK_TTL_MS,
  });
}

export function clearPendingLinkCookie(res: Response): void {
  res.clearCookie(PENDING_LINK_COOKIE_NAME, COOKIE_OPTIONS);
}
