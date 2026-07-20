// ─── Regex Constants ──────────────────────────────────────────────────────────

export const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
export const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
export const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;

// ─── JWT / Auth Constants ─────────────────────────────────────────────────────

export const JWT_ISSUER = 'flickssuite.com';
export const JWT_AUDIENCE = 'flicks-app';
export const OTP_EXPIRY_MINUTES = 10;
export const MAGIC_LINK_EXPIRY_MINUTES = 10;
export const REFRESH_TOKEN_EXPIRY_DAYS = 30;
export const TRUSTED_DEVICE_EXPIRY_DAYS = 180;
export const MAX_OTP_ATTEMPTS = 5;
export const EMPLOYEE_INVITE_EXPIRY_DAYS = 14;
export const IMPERSONATION_SESSION_MINUTES = 30;

// ─── Working Day Defaults ─────────────────────────────────────────────────────

/** Days of week: 1=Monday … 5=Friday */
export const DEFAULT_WORKING_DAYS: number[] = [1, 2, 3, 4, 5];
export const DEFAULT_WORK_START = '09:00';
export const DEFAULT_WORK_END = '18:00';
export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

// ─── Indian States & Union Territories ───────────────────────────────────────

export const INDIAN_STATES: Array<{ code: string; name: string }> = [
  // 28 States
  { code: 'AP', name: 'Andhra Pradesh' },
  { code: 'AR', name: 'Arunachal Pradesh' },
  { code: 'AS', name: 'Assam' },
  { code: 'BR', name: 'Bihar' },
  { code: 'CG', name: 'Chhattisgarh' },
  { code: 'GA', name: 'Goa' },
  { code: 'GJ', name: 'Gujarat' },
  { code: 'HR', name: 'Haryana' },
  { code: 'HP', name: 'Himachal Pradesh' },
  { code: 'JH', name: 'Jharkhand' },
  { code: 'KA', name: 'Karnataka' },
  { code: 'KL', name: 'Kerala' },
  { code: 'MP', name: 'Madhya Pradesh' },
  { code: 'MH', name: 'Maharashtra' },
  { code: 'MN', name: 'Manipur' },
  { code: 'ML', name: 'Meghalaya' },
  { code: 'MZ', name: 'Mizoram' },
  { code: 'NL', name: 'Nagaland' },
  { code: 'OD', name: 'Odisha' },
  { code: 'PB', name: 'Punjab' },
  { code: 'RJ', name: 'Rajasthan' },
  { code: 'SK', name: 'Sikkim' },
  { code: 'TN', name: 'Tamil Nadu' },
  { code: 'TS', name: 'Telangana' },
  { code: 'TR', name: 'Tripura' },
  { code: 'UP', name: 'Uttar Pradesh' },
  { code: 'UK', name: 'Uttarakhand' },
  { code: 'WB', name: 'West Bengal' },
  // 8 Union Territories
  { code: 'AN', name: 'Andaman and Nicobar Islands' },
  { code: 'CH', name: 'Chandigarh' },
  { code: 'DH', name: 'Dadra and Nagar Haveli and Daman and Diu' },
  { code: 'DL', name: 'Delhi' },
  { code: 'JK', name: 'Jammu and Kashmir' },
  { code: 'LA', name: 'Ladakh' },
  { code: 'LD', name: 'Lakshadweep' },
  { code: 'PY', name: 'Puducherry' },
];

// ─── Default Leave Types (PRD Section 7.2) ───────────────────────────────────

export interface DefaultLeaveType {
  code: string;
  name: string;
  description: string;
  isPaid: boolean;
  accrualMethod: 'monthly' | 'quarterly' | 'annual' | 'on_joining';
  accrualDays: number;
  maxBalance: number | null;
  isCarryForward: boolean;
  maxCarryForward: number | null;
  requiresApproval: boolean;
  requiresDocument: boolean;
  documentRequiredAfterDays: number | null;
  noticeDaysRequired: number;
  isHalfDayAllowed: boolean;
  applicableGender: 'all' | 'male' | 'female';
  minDaysPerRequest: number;
  maxDaysPerRequest: number | null;
  sortOrder: number;
}

export const INDIAN_LEAVE_TYPES: DefaultLeaveType[] = [
  {
    code: 'PL',
    name: 'Privilege Leave',
    description:
      'Earned/privilege leave accrued monthly. Can be used for planned personal time off.',
    isPaid: true,
    accrualMethod: 'monthly',
    accrualDays: 1.25, // 15 days per year
    maxBalance: 45,
    isCarryForward: true,
    maxCarryForward: 30,
    requiresApproval: true,
    requiresDocument: false,
    documentRequiredAfterDays: null,
    noticeDaysRequired: 3,
    isHalfDayAllowed: true,
    applicableGender: 'all',
    minDaysPerRequest: 1,
    maxDaysPerRequest: null,
    sortOrder: 1,
  },
  {
    code: 'CL',
    name: 'Casual Leave',
    description:
      'Short-duration leave for personal/urgent matters. Cannot be accumulated.',
    isPaid: true,
    accrualMethod: 'annual',
    accrualDays: 12,
    maxBalance: 12,
    isCarryForward: false,
    maxCarryForward: null,
    requiresApproval: true,
    requiresDocument: false,
    documentRequiredAfterDays: null,
    noticeDaysRequired: 1,
    isHalfDayAllowed: true,
    applicableGender: 'all',
    minDaysPerRequest: 0.5,
    maxDaysPerRequest: 3,
    sortOrder: 2,
  },
  {
    code: 'SL',
    name: 'Sick Leave',
    description:
      'Leave for medical illness or injury. Medical certificate required for more than 2 consecutive days.',
    isPaid: true,
    accrualMethod: 'annual',
    accrualDays: 12,
    maxBalance: 12,
    isCarryForward: false,
    maxCarryForward: null,
    requiresApproval: true,
    requiresDocument: true,
    documentRequiredAfterDays: 2,
    noticeDaysRequired: 0,
    isHalfDayAllowed: true,
    applicableGender: 'all',
    minDaysPerRequest: 0.5,
    maxDaysPerRequest: null,
    sortOrder: 3,
  },
  {
    code: 'ML',
    name: 'Maternity Leave',
    description:
      'Paid maternity leave as per the Maternity Benefit (Amendment) Act 2017. 26 weeks for first two children.',
    isPaid: true,
    accrualMethod: 'on_joining',
    accrualDays: 182, // 26 weeks
    maxBalance: 182,
    isCarryForward: false,
    maxCarryForward: null,
    requiresApproval: true,
    requiresDocument: true,
    documentRequiredAfterDays: 0,
    noticeDaysRequired: 30,
    isHalfDayAllowed: false,
    applicableGender: 'female',
    minDaysPerRequest: 1,
    maxDaysPerRequest: 182,
    sortOrder: 4,
  },
  {
    code: 'PAL',
    name: 'Paternity Leave',
    description:
      'Leave for fathers on birth or adoption of a child.',
    isPaid: true,
    accrualMethod: 'on_joining',
    accrualDays: 15,
    maxBalance: 15,
    isCarryForward: false,
    maxCarryForward: null,
    requiresApproval: true,
    requiresDocument: true,
    documentRequiredAfterDays: 0,
    noticeDaysRequired: 7,
    isHalfDayAllowed: false,
    applicableGender: 'male',
    minDaysPerRequest: 1,
    maxDaysPerRequest: 15,
    sortOrder: 5,
  },
  {
    code: 'BRL',
    name: 'Bereavement Leave',
    description:
      'Leave granted on death of an immediate family member (spouse, child, parent, sibling).',
    isPaid: true,
    accrualMethod: 'on_joining',
    accrualDays: 5,
    maxBalance: 5,
    isCarryForward: false,
    maxCarryForward: null,
    requiresApproval: true,
    requiresDocument: false,
    documentRequiredAfterDays: null,
    noticeDaysRequired: 0,
    isHalfDayAllowed: false,
    applicableGender: 'all',
    minDaysPerRequest: 1,
    maxDaysPerRequest: 5,
    sortOrder: 6,
  },
  {
    code: 'COL',
    name: 'Comp Off',
    description:
      'Compensatory off earned by working on weekends or holidays.',
    isPaid: true,
    accrualMethod: 'on_joining',
    accrualDays: 0,
    maxBalance: 10,
    isCarryForward: false,
    maxCarryForward: null,
    requiresApproval: true,
    requiresDocument: false,
    documentRequiredAfterDays: null,
    noticeDaysRequired: 0,
    isHalfDayAllowed: true,
    applicableGender: 'all',
    minDaysPerRequest: 0.5,
    maxDaysPerRequest: null,
    sortOrder: 7,
  },
  {
    code: 'LOP',
    name: 'Loss of Pay',
    description:
      'Unpaid leave when no paid leave balance is available.',
    isPaid: false,
    accrualMethod: 'on_joining',
    accrualDays: 0,
    maxBalance: null,
    isCarryForward: false,
    maxCarryForward: null,
    requiresApproval: true,
    requiresDocument: false,
    documentRequiredAfterDays: null,
    noticeDaysRequired: 1,
    isHalfDayAllowed: true,
    applicableGender: 'all',
    minDaysPerRequest: 0.5,
    maxDaysPerRequest: null,
    sortOrder: 8,
  },
  {
    code: 'WFH',
    name: 'Work From Home',
    description:
      'Approved work-from-home days for employees not in a fully remote role.',
    isPaid: true,
    accrualMethod: 'monthly',
    accrualDays: 4,
    maxBalance: 8,
    isCarryForward: false,
    maxCarryForward: null,
    requiresApproval: true,
    requiresDocument: false,
    documentRequiredAfterDays: null,
    noticeDaysRequired: 1,
    isHalfDayAllowed: true,
    applicableGender: 'all',
    minDaysPerRequest: 0.5,
    maxDaysPerRequest: null,
    sortOrder: 9,
  },
  {
    code: 'OD',
    name: 'On Duty',
    description:
      'Employee is on official duty outside the primary work location (travel, client visits, etc.).',
    isPaid: true,
    accrualMethod: 'on_joining',
    accrualDays: 0,
    maxBalance: null,
    isCarryForward: false,
    maxCarryForward: null,
    requiresApproval: true,
    requiresDocument: false,
    documentRequiredAfterDays: null,
    noticeDaysRequired: 0,
    isHalfDayAllowed: true,
    applicableGender: 'all',
    minDaysPerRequest: 0.5,
    maxDaysPerRequest: null,
    sortOrder: 10,
  },
  {
    code: 'SAB',
    name: 'Sabbatical',
    description:
      'Extended leave for personal development, higher education, or research. Subject to management approval.',
    isPaid: false,
    accrualMethod: 'on_joining',
    accrualDays: 0,
    maxBalance: 90,
    isCarryForward: false,
    maxCarryForward: null,
    requiresApproval: true,
    requiresDocument: true,
    documentRequiredAfterDays: 0,
    noticeDaysRequired: 60,
    isHalfDayAllowed: false,
    applicableGender: 'all',
    minDaysPerRequest: 30,
    maxDaysPerRequest: 90,
    sortOrder: 11,
  },
];

// ─── Consent & policy versions (PRD v4 §3) ───────────────────────────────────
// Bumping TERMS_VERSION / PRIVACY_VERSION triggers the re-acceptance
// interstitial exactly once per user (latest terms_privacy ledger row is
// compared against these).

export const TERMS_VERSION = 'tos-2026-07-01';
export const PRIVACY_VERSION = 'privacy-2026-07-01';
export const CONSENT_VERSION = 'consent-v1';

export type ConsentType = 'terms_privacy' | 'analytics' | 'marketing_email';
export const CONSENT_TYPES: ConsentType[] = [
  'terms_privacy',
  'analytics',
  'marketing_email',
];

/** Platform trial length in days (PRD v4 — user-locked at 7). */
export const TRIAL_DAYS = 7;

/**
 * The single platform plan (PRD v4 §8B — beta pricing). Stored per-seat price
 * is in INR rupees on the subscriptions row; Razorpay item amounts are paise.
 */
export const PLATFORM_PLAN = {
  code: 'beta',
  pricePaise: 49_900, // ₹499 / seat / month
  priceRupees: 499,
  currency: 'INR' as const,
  displayUsd: 5.99,
  interval: 'monthly' as const,
};

/** Days of grace after a failed platform charge before the workspace locks. */
export const BILLING_GRACE_DAYS = 7;

// ─── PRD v5: domain events + reserved slugs + public API ─────────────────────

/**
 * Domain-event catalog (PRD v5 Appendix A). The outbox (`domain_events`)
 * accepts only names from this list — a typo'd publisher fails fast instead of
 * silently emitting an event nobody subscribes to. Payloads: ids/enums/amounts
 * only, never PII or message bodies.
 */
export const DOMAIN_EVENTS = [
  // CRM (published from Sprint 25 onward)
  'crm.lead.created', 'crm.lead.converted', 'crm.lead.discarded',
  'crm.contact.created', 'crm.contact.updated', 'crm.contact.merged',
  'crm.company.created', 'crm.company.updated', 'crm.company.merged',
  'crm.deal.created', 'crm.deal.updated', 'crm.deal.stage_changed',
  'crm.deal.won', 'crm.deal.lost', 'crm.deal.reopened', 'crm.deal.invoice_created',
  'crm.deal.quote_created',
  'crm.activity.created', 'crm.activity.completed', 'crm.activity.overdue',
  'crm.email.queued', 'crm.email.sent', 'crm.email.delivered', 'crm.email.opened',
  'crm.email.clicked', 'crm.email.replied', 'crm.email.bounced',
  'crm.sequence.enrolled', 'crm.sequence.step_sent', 'crm.sequence.exited', 'crm.sequence.completed',
  'crm.form.submitted', 'crm.import.completed',
  'crm.workflow.run_completed', 'crm.workflow.run_failed',
  // Existing modules (Sprint 24 publishers)
  'invoice.created', 'invoice.sent', 'invoice.paid', 'invoice.quote_accepted',
  'member.deactivated',
  // PM (PRD v6 Appendix A) — every event advances domain_events.sync_seq and
  // therefore the FSE delta cursor; payloads are ids/enums/numbers only.
  'pm.team.created', 'pm.team.updated', 'pm.team.membership_changed', 'pm.team.privacy_changed',
  'pm.state.created', 'pm.state.updated',
  'pm.label.created', 'pm.label.updated',
  'pm.issue.created', 'pm.issue.updated', 'pm.issue.state_changed', 'pm.issue.priority_changed',
  'pm.issue.assigned', 'pm.issue.estimated', 'pm.issue.ranked', 'pm.issue.labeled',
  'pm.issue.related', 'pm.issue.subscribed', 'pm.issue.commented', 'pm.issue.reaction_added',
  'pm.issue.sent_to_triage', 'pm.issue.triaged', 'pm.issue.snoozed',
  'pm.issue.deleted', 'pm.issue.restored',
  'pm.cycle.created', 'pm.cycle.started', 'pm.cycle.ended', 'pm.cycle.rollover_completed',
  'pm.cycle.snapshot_taken',
  'pm.project.created', 'pm.project.updated', 'pm.project.status_changed',
  'pm.project.health_updated', 'pm.project.milestone_changed', 'pm.project.completed',
  'pm.project.created_from_deal',
  'pm.initiative.created', 'pm.initiative.updated',
  'pm.template.saved',
  'pm.view.saved', 'pm.view.favorited',
  'pm.github.installed', 'pm.github.repo_mapped', 'pm.github.link_attached',
  'pm.github.automation_fired',
  'pm.import.completed',
] as const;
export type DomainEventName = (typeof DOMAIN_EVENTS)[number];

/**
 * Slugs that can never become tenant subdomains (PRD v5 §1) — they collide
 * with the platform's own hosts and public surfaces. Enforced at signup and
 * on slug change; existing tenants audited once during rollout.
 */
export const RESERVED_TENANT_SLUGS = [
  'app', 'api', 'www', 'mail', 'in', 'admin', 'status', 'docs', 'help',
  'support', 'assets', 'cdn', 'static', 'blog', 'billing', 'legal',
] as const;

/** Public-API key scopes (PRD v5 §11). */
export const API_KEY_SCOPES = [
  'crm:read', 'crm:write', 'directory:read', 'directory:write', 'webhooks:manage',
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
