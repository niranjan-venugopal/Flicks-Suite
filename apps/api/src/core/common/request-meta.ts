import type { Request } from 'express';

/** IP + user agent of the caller, for audit rows. `trust proxy` is set in main.ts. */
export interface ClientMeta {
  ip?: string;
  userAgent?: string;
}

export function clientMeta(req: Request | undefined): ClientMeta {
  if (!req) return {};
  const ua = req.headers?.['user-agent'];
  return {
    ip: req.ip ?? req.socket?.remoteAddress ?? undefined,
    userAgent: Array.isArray(ua) ? ua[0] : (ua ?? undefined),
  };
}
