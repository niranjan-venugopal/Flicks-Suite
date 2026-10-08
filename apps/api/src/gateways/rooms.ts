/**
 * Round R — socket rooms are scoped to the company.
 *
 * A person who belongs to several companies has one browser session per
 * company; pushes carrying company data (a notification's text, a board
 * change) must only reach the sockets of THAT company's session, never a tab
 * showing another company. Every gateway joins the three rooms below on
 * connect and leaves them the moment the seat is switched off.
 */
export const SEAT_REVOKED_EVENT = 'seat.revoked';

export interface SeatRevokedPayload {
  tenantId: string;
  userId: string;
}

/** Every socket of one person inside one company. */
export function tenantUserRoom(tenantId: string, userId: string): string {
  return `tenant:${tenantId}:user:${userId}`;
}

/** Every socket of one company. */
export function tenantRoom(tenantId: string): string {
  return `tenant:${tenantId}`;
}

/**
 * Where a push for one person goes: the company-scoped room when the push
 * belongs to a company, the plain user room (every company's tabs) only for
 * account-level pushes that carry no company at all.
 */
export function userRoom(userId: string, tenantId?: string | null): string {
  return tenantId ? tenantUserRoom(tenantId, userId) : `user:${userId}`;
}
