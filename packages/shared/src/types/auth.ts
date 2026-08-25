// ─── Auth Types ──────────────────────────────────────────────────────────────

// 'super_admin' kept for backwards-compat with legacy rows; 'fam' is the
// canonical name for the Specflicks-internal platform admin role.
// 'auditor' (Invoicing v3): finance-scoped, grant-driven, multi-company,
// non-billable. It is orthogonal to the role hierarchy — invoicing access is
// resolved by membership_grants via the grant guard, not the role rank.
// 'guest' (PM v1.5, round 7): project-scoped external collaborator —
// orthogonal like auditor; PM access via membership_grants, visibility via
// pm_project_members. Non-billable.
export type UserRole = 'fam' | 'super_admin' | 'owner' | 'admin' | 'manager' | 'finance' | 'employee' | 'auditor' | 'guest';

export type TenantStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'suspended';

export type AuthEventType =
  | 'otp_requested'
  | 'otp_verified'
  | 'otp_failed'
  | 'otp_expired'
  | 'magic_link_requested'
  | 'magic_link_used'
  | 'magic_link_expired'
  | 'login_success'
  | 'login_failed'
  | 'logout'
  | 'token_refreshed'
  | 'token_revoked'
  | 'tenant_selected'
  | 'device_trusted'
  | 'device_revoked'
  | 'impersonation_started'
  | 'impersonation_ended'
  | 'password_reset_requested'
  | 'account_locked'
  | 'account_unlocked';

export interface JwtPayload {
  /** Subject — user UUID */
  sub: string;
  email: string;
  tenantId: string;
  membershipId: string;
  role: UserRole;
  isPlatformAdmin: boolean;
  deviceId: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
  /** Present only when an admin is impersonating this user */
  impersonatorUserId?: string;
}

export interface LoginResponse {
  requiresTenantSelection: boolean;
  tenants?: Array<{
    id: string;
    name: string;
    slug: string;
    logoUrl: string | null;
    role: UserRole;
    status: TenantStatus;
  }>;
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  user?: {
    id: string;
    email: string;
    fullName: string;
    avatarUrl: string | null;
  };
}

export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface MeResponse {
  id: string;
  email: string;
  fullName: string;
  avatarUrl: string | null;
  role: UserRole;
  isPlatformAdmin: boolean;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  tenantStatus: TenantStatus;
  membershipId: string;
  employeeId: string | null;
  deviceId: string;
}
