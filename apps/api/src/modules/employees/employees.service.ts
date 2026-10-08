import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
  Inject,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { eq, ne, and, inArray, desc, asc, sql, or, isNull, isNotNull, lte, gte, lt, gt } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import * as crypto from 'crypto';
import {
  employees,
  users,
  memberships,
  tenants,
  departments,
  designations,
  employmentHistory,
  employeeDocuments,
  emergencyContacts,
  locations,
  attendanceRecords,
  attendancePunches,
  leaveBalances,
  leaveRequests,
  leaveTypes,
  timesheetEntries,
  dataConsents,
  employeeChangeRequests,
  shiftTemplates,
  employeeShifts,
  employeeInvitations,
  refreshTokens,
} from '@flicks/db/schema';

// Bump when the privacy policy / consent copy materially changes so we can
// tell which version each principal agreed to (DPDP audit requirement).
const CONSENT_VERSION = '2026-05-v1';
import { DatabaseService } from '../../core/database/database.service';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import { FieldCipher } from '../../core/common/field-cipher';
import type { Db, DbAdmin } from '@flicks/db';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuthService } from '../auth/auth.service';
import { MediaService } from '../media/media.service';
import { R2Service } from '../../core/storage/r2.service';
import {
  actorSeatRoleTx,
  assertMayActOnSeat,
  assertNotLastOwnerTx,
  isSeniorSeat as isSeniorSeatRole,
} from '../../core/auth/seat-guards';
import { addDaysISO } from '../../core/common/time';
import { tenantTodayISOTx } from '../../core/common/workday';
// Round P R4: equipment held by the person — plain tx helpers via the assets
// module's public facade (house rule 3), run inside our own tenant tx.
import {
  countAllAssignmentsTx,
  listOpenAssignmentsTx,
} from '../assets/public';
import type {
  InviteEmployeeDto,
  UpdateEmployeeDto,
  SelfUpdateEmployeeDto,
  SubmitOnboardingStepDto,
  TransferEmployeeDto,
  TerminateEmployeeDto,
  EmployeeListQueryDto,
  ImportEmployeesDto,
} from './employees.dto';
import { ConfigService } from '@nestjs/config';

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// ─── Round P (R1.1 / R1.2) invite plumbing ───────────────────────────────────

/** A second invite to the same person is allowed once a minute. */
const RESEND_WINDOW_MS = 60_000;

/** Import-only signal: the row matched a pending invitee and was skipped. */
class PendingInviteeSkipped extends Error {
  constructor(public readonly email: string) {
    super('already invited — use Resend invite');
    this.name = 'PendingInviteeSkipped';
  }
}

interface PgErrorLike {
  code?: string;
  /** node-postgres spelling. */
  constraint?: string;
  /** postgres.js spelling (what @flicks/db uses). */
  constraint_name?: string;
  cause?: unknown;
}

/** The Postgres unique violation on `err` or up its `cause` chain, if any. */
function findUniqueViolation(err: unknown): PgErrorLike | null {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const candidate = current as PgErrorLike;
    if (candidate.code === '23505') return candidate;
    current = candidate.cause;
  }
  return null;
}

// Correlated columns the directory and the 360 both need (R1.3). The seat is
// looked up by employee_id first (how inviteEmployee links it) and by user_id
// second (legacy rows whose seat was never linked), inside the tenant tx so
// RLS scopes both subqueries.
const MEMBERSHIP_STATUS_SQL = sql<string | null>`COALESCE(
  (SELECT m.status::text FROM memberships m
     WHERE m.tenant_id = ${employees.tenant_id} AND m.employee_id = ${employees.id}
     ORDER BY m.created_at ASC LIMIT 1),
  (SELECT m.status::text FROM memberships m
     WHERE m.tenant_id = ${employees.tenant_id} AND ${employees.user_id} IS NOT NULL AND m.user_id = ${employees.user_id}
     ORDER BY m.created_at ASC LIMIT 1)
)`;
const ONBOARDING_STEP_SQL = sql<number>`COALESCE((${employees.custom_fields}->>'onboarding_step')::int, 0)`;
const ONBOARDING_SUBMITTED_SQL = sql<boolean>`COALESCE((${employees.custom_fields}->>'onboarding_submitted_for_review')::boolean, false)`;

// Fields to exclude from API responses (sensitive data)
const SAFE_EMPLOYEE_FIELDS = {
  id: employees.id,
  tenant_id: employees.tenant_id,
  user_id: employees.user_id,
  employee_code: employees.employee_code,
  status: employees.status,
  employment_type: employees.employment_type,
  date_of_joining: employees.date_of_joining,
  department_id: employees.department_id,
  location_id: employees.location_id,
  reporting_manager_id: employees.reporting_manager_id,
  designation_id: employees.designation_id,
  custom_fields: employees.custom_fields,
  created_at: employees.created_at,
  updated_at: employees.updated_at,
} as const;

// ─── Peer redaction for GET /employees/:id (founder round K) ─────────────────
// The 360° record carries the personal block (home address, personal
// contact, DOB, statutory + bank details). A colleague may open any profile
// for the org chart / directory, but only the person themselves, their
// direct reporting manager, and owner / admin / finance / fam get that
// block — the same predicate as GET /attendance/employee/:id (round 15).
// Applied in the controller only; GET /employees/me and every internal
// caller keep the full record.

export interface EmployeeViewer {
  /** The viewer's own employee row in this tenant (membership bridge), if any. */
  employeeId: string | null;
  /** Lowercase API membership role from the JWT. */
  role: string | undefined;
}

const PERSONAL_BLOCK_FIELDS = [
  'personalEmail',
  'personalPhone',
  'currentAddress',
  'permanentAddress',
  'dateOfBirth',
  'maritalStatus',
  'bloodGroup',
  'aadhaarLast4',
  'hasPan',
  'hasPassport',
  'bankName',
  'bankBranch',
  'bankIfsc',
  'bankAccountType',
  'bankAccountHolder',
  'hasBankAccount',
  'pfUan',
  'esicNumber',
  'pfApplicable',
  'esiApplicable',
  // Not "contact details", but the same rule applies (founder: no leakage):
  // GET /attendance/employee/:id refuses a peer these numbers, so the 360
  // overview must not hand them out either.
  'gender',
  'nationality',
  'thisMonth',
  'customFields',
] as const;

export function canViewPersonalBlock(
  record: { id: string; reportingManagerId: string | null },
  viewer: EmployeeViewer,
): boolean {
  const elevated = ['owner', 'admin', 'finance', 'fam', 'super_admin'].includes(
    viewer.role ?? '',
  );
  const isSelf = viewer.employeeId !== null && viewer.employeeId === record.id;
  const managesTarget =
    viewer.role === 'manager' &&
    viewer.employeeId !== null &&
    record.reportingManagerId === viewer.employeeId;
  return elevated || isSelf || managesTarget;
}

/** Pure: returns the record untouched for an allowed viewer, else a copy with the personal block nulled, no emergency contacts and no leave balances. */
export function redactForViewer<
  T extends { id: string; reportingManagerId: string | null; emergencyContacts: unknown[] },
>(record: T, viewer: EmployeeViewer): T {
  if (canViewPersonalBlock(record, viewer)) return record;
  const redacted: Record<string, unknown> = {
    ...record,
    emergencyContacts: [],
    leaveBalances: [],
  };
  for (const field of PERSONAL_BLOCK_FIELDS) redacted[field] = null;
  return redacted as T;
}

@Injectable()
export class EmployeesService {
  private readonly logger = new Logger(EmployeesService.name);

  // Every query runs through databaseService.withTenant(tenantId, …) so that
  // app.tenant_id is set for the duration of the transaction and the RLS
  // policies on the tenant tables resolve correctly. Under the NOBYPASSRLS
  // app role, a query without that context returns zero rows — so this is
  // load-bearing, not just defense-in-depth.
  constructor(
    private readonly databaseService: DatabaseService,
    // Identity provisioning (find-or-create a user by email during invite) must
    // see users across tenants — a person can already exist in another tenant —
    // so it runs on the service-role (BYPASSRLS) connection. The users RLS
    // policy (0010) otherwise scopes user visibility to the current tenant.
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    private readonly authService: AuthService,
    // Resolves users.avatar_key into a signed URL. Every read surface that
    // renders a face must go through this: the upload path writes ONLY
    // avatar_key, so the legacy avatar_url columns stay null forever.
    private readonly mediaService: MediaService,
    // Signs employee-document GETs (security audit 2026-10-06). Optional and
    // last so hand-built services in specs keep compiling; R2 is global.
    @Optional() private readonly r2?: R2Service,
  ) {}

  // AES-256-GCM for sensitive at-rest columns (PAN, bank account number).
  // Blank key (local dev) = plaintext passthrough; decrypt handles legacy
  // plaintext rows written before encryption shipped.
  private readonly fieldCipher = new FieldCipher(
    process.env.EMPLOYEE_DATA_ENC_KEY,
    'flicks-employee-fields-v1',
  );

  async listEmployees(tenantId: string, query: EmployeeListQueryDto) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const offset = (page - 1) * limit;

    // `removed: true` is how the Removed filter on the directory asks for the
    // archived rows; every other caller gets live employees only (round 21).
    const conditions = [
      eq(employees.tenant_id, tenantId),
      query.removed ? isNotNull(employees.deleted_at) : isNull(employees.deleted_at),
    ];

    if (query.departmentId) {
      conditions.push(eq(employees.department_id, query.departmentId));
    }
    if (query.locationId) {
      conditions.push(eq(employees.location_id, query.locationId));
    }
    if (query.status) {
      conditions.push(eq(employees.status, query.status as typeof employees.status._.data));
    }

    const { result, total } = await this.databaseService.withTenant(tenantId, async (db) => {
      const result = await db
        .select({
          id: employees.id,
          employeeCode: employees.employee_code,
          status: employees.status,
          employmentType: employees.employment_type,
          dateOfJoining: employees.date_of_joining,
          departmentId: employees.department_id,
          departmentName: departments.name,
          locationId: employees.location_id,
          locationName: locations.name,
          reportingManagerId: employees.reporting_manager_id,
          designationId: employees.designation_id,
          userId: employees.user_id,
          fullName: users.full_name,
          email: users.email,
          avatarUrl: users.avatar_url,
          avatarKey: users.avatar_key, // §4 — controller swaps for a signed URL
          createdAt: employees.created_at,
          // Round P (R1.3): the directory derives its Invited / Onboarding /
          // Awaiting approval / No access pills from these three.
          membershipStatus: MEMBERSHIP_STATUS_SQL,
          onboardingStep: ONBOARDING_STEP_SQL,
          onboardingSubmitted: ONBOARDING_SUBMITTED_SQL,
        })
        .from(employees)
        .leftJoin(users, eq(employees.user_id, users.id))
        .leftJoin(departments, eq(employees.department_id, departments.id))
        .leftJoin(locations, eq(employees.location_id, locations.id))
        .where(and(...conditions))
        .orderBy(desc(employees.created_at))
        .limit(limit)
        .offset(offset);
      // A real count: `total = rows on this page` made "Showing first N"
      // and the header counts lie past the first page.
      const [cnt] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(employees)
        .where(and(...conditions));
      return { result, total: Number(cnt?.n ?? 0) };
    });

    return {
      data: result,
      pagination: { page, limit, total },
    };
  }

  /**
   * FK constraints bypass RLS, so an org ref accepted from a DTO
   * (department/designation/location/manager id) would happily point at
   * another tenant's row. These lookups run inside the tenant transaction
   * (RLS-scoped), so a cross-tenant id resolves to nothing and is rejected —
   * same pattern as assertRefsInTenant in crm/deals.service.ts.
   */
  private async assertOrgRefsInTenant(
    db: Db,
    tenantId: string,
    refs: {
      departmentId?: string | null;
      designationId?: string | null;
      locationId?: string | null;
      managerEmployeeId?: string | null;
      shiftTemplateId?: string | null;
    },
  ): Promise<void> {
    if (refs.departmentId) {
      const [row] = await db
        .select({ id: departments.id })
        .from(departments)
        .where(and(eq(departments.id, refs.departmentId), eq(departments.tenant_id, tenantId)))
        .limit(1);
      if (!row) throw new BadRequestException('departmentId does not belong to this workspace');
    }
    if (refs.designationId) {
      const [row] = await db
        .select({ id: designations.id })
        .from(designations)
        .where(and(eq(designations.id, refs.designationId), eq(designations.tenant_id, tenantId)))
        .limit(1);
      if (!row) throw new BadRequestException('designationId does not belong to this workspace');
    }
    if (refs.locationId) {
      const [row] = await db
        .select({ id: locations.id })
        .from(locations)
        .where(and(eq(locations.id, refs.locationId), eq(locations.tenant_id, tenantId)))
        .limit(1);
      if (!row) throw new BadRequestException('locationId does not belong to this workspace');
    }
    if (refs.managerEmployeeId) {
      const [row] = await db
        .select({ id: employees.id })
        .from(employees)
        .where(and(eq(employees.id, refs.managerEmployeeId), eq(employees.tenant_id, tenantId)))
        .limit(1);
      if (!row) throw new BadRequestException('managerId does not belong to this workspace');
    }
    if (refs.shiftTemplateId) {
      const [row] = await db
        .select({ id: shiftTemplates.id })
        .from(shiftTemplates)
        .where(
          and(
            eq(shiftTemplates.id, refs.shiftTemplateId),
            eq(shiftTemplates.tenant_id, tenantId),
            eq(shiftTemplates.is_active, true),
          ),
        )
        .limit(1);
      if (!row) throw new BadRequestException('shiftTemplateId does not belong to this workspace');
    }
  }

  /**
   * Point `employeeId` at `shiftTemplateId` from `fromDate` (YYYY-MM-DD)
   * onward, or back at the tenant default when null. History is preserved:
   * an already-running mapping is closed the day before, while one that never
   * took effect (starts today or later) is replaced outright. The attendance
   * engine reads these rows per-day (resolveShiftTemplate), so lateness and
   * worked-hours math follows the change from `fromDate` without rewriting
   * the past.
   */
  private async writeShiftAssignment(
    db: Db,
    tenantId: string,
    employeeId: string,
    shiftTemplateId: string | null,
    fromDate: string,
  ): Promise<void> {
    await db
      .update(employeeShifts)
      .set({ effective_to: sql`(${fromDate}::date - 1)` })
      .where(
        and(
          eq(employeeShifts.tenant_id, tenantId),
          eq(employeeShifts.employee_id, employeeId),
          lt(employeeShifts.effective_from, fromDate),
          or(isNull(employeeShifts.effective_to), gte(employeeShifts.effective_to, fromDate)),
        ),
      );
    await db
      .delete(employeeShifts)
      .where(
        and(
          eq(employeeShifts.tenant_id, tenantId),
          eq(employeeShifts.employee_id, employeeId),
          gte(employeeShifts.effective_from, fromDate),
        ),
      );
    if (shiftTemplateId) {
      await db.insert(employeeShifts).values({
        tenant_id: tenantId,
        employee_id: employeeId,
        shift_template_id: shiftTemplateId,
        effective_from: fromDate,
      });
    }
  }

  /**
   * Resolves the AuthService invite-link call. The real service exposes the
   * detailed shape (url + token hash + expiry, Round P) which the
   * `employee_invitations` ledger needs. AuthService doubles that predate it
   * only expose the URL (and may hand back the same URL every call), so on
   * that path the ledger gets a random placeholder hash — the row still
   * records the send for throttling and resent_count.
   */
  private async issueInviteLink(
    userId: string,
    email: string,
  ): Promise<{ url: string; tokenHash: string; expiresAt: Date }> {
    const auth = this.authService as Partial<AuthService>;
    if (typeof auth.issueInviteMagicLinkDetailed === 'function') {
      return auth.issueInviteMagicLinkDetailed(userId, email);
    }
    const url = await this.authService.issueInviteMagicLink(userId, email);
    return {
      url,
      tokenHash: sha256(`legacy:${crypto.randomBytes(32).toString('hex')}`),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    };
  }

  /**
   * One `employee_invitations` row per send; `resent_count` is the ordinal
   * (0 = the first invite). Runs inside the caller's tenant tx; flicks_app
   * holds INSERT on the table under the tenant_isolation policy (verified).
   */
  private async writeInvitationLedger(
    db: Db,
    args: {
      tenantId: string;
      employeeId: string;
      email: string;
      tokenHash: string;
      expiresAt: Date;
      invitedBy: string;
    },
  ): Promise<number> {
    const [prior] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(employeeInvitations)
      .where(
        and(
          eq(employeeInvitations.tenant_id, args.tenantId),
          eq(employeeInvitations.employee_id, args.employeeId),
        ),
      );
    const resentCount = Number(prior?.n ?? 0);
    await db.insert(employeeInvitations).values({
      tenant_id: args.tenantId,
      employee_id: args.employeeId,
      email: args.email,
      token_hash: args.tokenHash,
      expires_at: args.expiresAt,
      resent_count: resentCount,
      invited_by: args.invitedBy,
    });
    return resentCount;
  }

  /**
   * True when the seat's `employee_id` points at a LIVE row other than
   * `employeeId` — e.g. the person was removed and re-added under another
   * work email. A restore / resend must not steal that seat (the person would
   * end up with two live rows and every "me" surface on the wrong one).
   */
  private async seatHeldByAnotherLiveRow(
    db: Db,
    tenantId: string,
    seat: { employee_id: string | null },
    employeeId: string,
  ): Promise<boolean> {
    if (!seat.employee_id || seat.employee_id === employeeId) return false;
    const [other] = await db
      .select({ id: employees.id })
      .from(employees)
      .where(
        and(
          eq(employees.id, seat.employee_id),
          eq(employees.tenant_id, tenantId),
          isNull(employees.deleted_at),
        ),
      )
      .limit(1);
    return !!other;
  }

  /** 429 when the ledger shows a send for this employee inside the window. */
  private async assertResendWindow(db: Db, tenantId: string, employeeId: string): Promise<void> {
    const since = new Date(Date.now() - RESEND_WINDOW_MS);
    const [recent] = await db
      .select({ id: employeeInvitations.id })
      .from(employeeInvitations)
      .where(
        and(
          eq(employeeInvitations.tenant_id, tenantId),
          eq(employeeInvitations.employee_id, employeeId),
          gt(employeeInvitations.created_at, since),
        ),
      )
      .limit(1);
    if (recent) {
      throw new HttpException(
        {
          code: 'RESEND_TOO_SOON',
          message: 'An invite was sent less than a minute ago — try again shortly',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Find-or-create the platform user for an invite. Service-role: a person
   * may already exist in another tenant and be invisible under the users RLS
   * policy. Called only AFTER the tenant-side prechecks passed, so a 409
   * never leaves an orphan users row behind (Round P R1.2).
   */
  private async findOrCreateInviteUser(email: string, fullName: string) {
    const [found] = await this.dbAdmin
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (found) return found;
    // Two admins inviting the same address at once: let the unique index
    // decide and re-read instead of surfacing a 23505.
    const [inserted] = await this.dbAdmin
      .insert(users)
      .values({ email, full_name: fullName })
      .onConflictDoNothing({ target: users.email })
      .returning();
    if (inserted) return inserted;
    const [again] = await this.dbAdmin
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (!again) throw new Error('Could not provision the invited user');
    return again;
  }

  /** Maps a unique violation raised inside the write tx to the user-facing 409. */
  private rethrowInviteWriteError(err: unknown, employeeCode: string): never {
    const violation = findUniqueViolation(err);
    if (!violation) throw err;
    const constraint = violation.constraint ?? violation.constraint_name;
    if (constraint === 'employees_tenant_work_email_unique') {
      throw new ConflictException({
        code: 'DUPLICATE',
        message: 'An employee with this work email already exists',
      });
    }
    if (constraint === 'employees_tenant_code_unique') {
      throw new ConflictException({
        code: 'DUPLICATE',
        message: `Employee code ${employeeCode} is already in use`,
      });
    }
    throw new ConflictException({
      code: 'DUPLICATE',
      message: 'A record with the same value already exists.',
    });
  }

  /**
   * Invite (or re-invite, or re-hire) a person by work email.
   *
   * Round P (R1.2) — "re-adding the same person" used to hit the raw
   * `employees_tenant_work_email_unique` text. The row for `(tenant, email)`
   * is now looked up INCLUDING archived rows, inside the tenant tx, before any
   * write, and the outcome follows the matrix:
   *
   *   no row                             → create (today's path); a deactivated
   *                                        seat for the same user (prior hard
   *                                        delete) is re-invited and linked, an
   *                                        active/invited unlinked seat is linked
   *   no row, guest/auditor seat         → 409 EXTERNAL_SEAT
   *   live, inactive, not yet submitted  → UPDATE with the form values + re-send
   *                                        the invite (`reinvited: true`)
   *   live, submitted / active / …       → 409 ALREADY_EMPLOYEE
   *   archived (deleted_at)              → re-hire IN PLACE (same employees.id,
   *                                        history intact), seat → invited
   *
   * Order of operations: tenant-side prechecks (read-only tx) → users
   * find-or-create (service role) → write tx (23505 mapped by constraint) →
   * invite link + ledger row → email → audit. Email sends and the magic-link
   * insert never run inside a tenant transaction.
   */
  async inviteEmployee(
    dto: InviteEmployeeDto,
    adminId: string,
    tenantId: string,
    opts?: { onPendingInvitee?: 'resend' | 'skip' },
  ) {
    const normalizedEmail = dto.email.toLowerCase().trim();

    const joiningDate = dto.joiningDate
      ? dto.joiningDate
      : new Date().toISOString().split('T')[0]!;

    const nameParts = dto.fullName.trim().split(/\s+/);
    const firstName = nameParts[0] ?? dto.fullName;
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

    // ─── Phase 1: who is this, if anyone (read-only, service role) ──────────
    const [knownUser] = await this.dbAdmin
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);

    // ─── Phase 2: tenant-side prechecks — nothing is written yet ────────────
    type Mode = 'create' | 'reinvite' | 'rehire';
    const plan = await this.databaseService.withTenant(tenantId, async (db) => {
      // Reject cross-tenant / dangling org refs before writing them.
      await this.assertOrgRefsInTenant(db, tenantId, {
        departmentId: dto.departmentId,
        designationId: dto.designationId,
        locationId: dto.locationId,
        managerEmployeeId: dto.managerId,
        shiftTemplateId: dto.shiftTemplateId,
      });

      const [byEmail] = await db
        .select({
          id: employees.id,
          userId: employees.user_id,
          employeeCode: employees.employee_code,
          status: employees.status,
          deletedAt: employees.deleted_at,
          customFields: employees.custom_fields,
        })
        .from(employees)
        .where(
          and(
            eq(employees.tenant_id, tenantId),
            eq(employees.work_email, normalizedEmail),
          ),
        )
        .limit(1);

      // The seat for this person in THIS workspace, if the user exists.
      const seatUserId = byEmail?.userId ?? knownUser?.id ?? null;
      const [seat] = seatUserId
        ? await db
            .select()
            .from(memberships)
            .where(
              and(
                eq(memberships.tenant_id, tenantId),
                eq(memberships.user_id, seatUserId),
              ),
            )
            .orderBy(asc(memberships.created_at))
            .limit(1)
        : [];

      // A guest/auditor seat never becomes an employee seat by side effect —
      // whichever row state the email is in, the admin removes that seat
      // first (the 409 says so).
      const externalSeat = !!seat && (seat.role === 'guest' || seat.role === 'auditor');
      const externalSeatConflict = () =>
        new ConflictException({
          code: 'EXTERNAL_SEAT',
          message: `${normalizedEmail} holds a guest/auditor seat — remove that seat in Settings → Members first`,
        });

      let mode: Mode;
      if (byEmail && !byEmail.deletedAt) {
        const custom = (byEmail.customFields as Record<string, unknown> | null) ?? {};
        const stillPending =
          byEmail.status === 'inactive' &&
          custom.onboarding_submitted_for_review !== true;
        if (!stillPending) {
          throw new ConflictException({
            code: 'ALREADY_EMPLOYEE',
            message: `${normalizedEmail} is already an employee (${byEmail.employeeCode}). Open their profile instead.`,
          });
        }
        if (opts?.onPendingInvitee === 'skip') {
          throw new PendingInviteeSkipped(normalizedEmail);
        }
        if (externalSeat) throw externalSeatConflict();
        // A seat revoked on purpose from Settings → Members stays revoked:
        // the form must agree with Resend invite (R1.1) instead of quietly
        // re-opening access as a side effect of a submit.
        if (seat?.status === 'deactivated') {
          throw new ConflictException({
            code: 'SEAT_DEACTIVATED',
            message:
              'Their workspace seat is deactivated — reactivate them from Settings → Members first',
          });
        }
        // Re-adding a pending invitee from the form = "send it again". Same
        // 60 s window as Resend invite, checked BEFORE any write.
        await this.assertResendWindow(db, tenantId, byEmail.id);
        mode = 'reinvite';
      } else if (byEmail?.deletedAt) {
        if (externalSeat) throw externalSeatConflict();
        mode = 'rehire';
      } else {
        mode = 'create';
        if (externalSeat) throw externalSeatConflict();
        if (seat?.employee_id) {
          // The seat already points at a live record under another work
          // email (HR changed it) — don't grow a second employee row.
          const [linked] = await db
            .select({
              code: employees.employee_code,
              workEmail: employees.work_email,
              deletedAt: employees.deleted_at,
            })
            .from(employees)
            .where(and(eq(employees.id, seat.employee_id), eq(employees.tenant_id, tenantId)))
            .limit(1);
          if (linked && !linked.deletedAt) {
            throw new ConflictException({
              code: 'ALREADY_EMPLOYEE',
              message: `This person is already an employee as ${linked.workEmail} (${linked.code}). Open their profile instead.`,
            });
          }
        }
      }

      // Employee-code check. REMOVED employees are deliberately included:
      // their row still holds the unique index on (tenant_id, employee_code),
      // so skipping them here would only move the failure to a raw
      // constraint violation. The row being re-invited / re-hired is excluded
      // — its own code is not a clash.
      const [codeClash] = await db
        .select({ id: employees.id, deletedAt: employees.deleted_at })
        .from(employees)
        .where(
          and(
            eq(employees.tenant_id, tenantId),
            eq(employees.employee_code, dto.employeeCode),
            byEmail ? ne(employees.id, byEmail.id) : undefined,
          ),
        )
        .limit(1);

      if (codeClash && mode === 'create') {
        throw new ConflictException(
          codeClash.deletedAt
            ? `Employee code ${dto.employeeCode} belongs to a removed employee. Restore them from People → Removed, or use a different code.`
            : `Employee code ${dto.employeeCode} is already in use`,
        );
      }
      // Re-invite / re-hire: the form's code applies only when it is free;
      // otherwise the row keeps the code it already has.
      const employeeCode =
        mode === 'create' || !codeClash ? dto.employeeCode : byEmail!.employeeCode;

      return { mode, byEmail: byEmail ?? null, seat: seat ?? null, employeeCode };
    });

    // ─── Phase 3: the platform user (after every 409 that could fire) ──────
    const currentUser = await this.findOrCreateInviteUser(normalizedEmail, dto.fullName);

    // ─── Phase 4: the write transaction ─────────────────────────────────────
    const { employee, companyName, seatAction } = await this.databaseService.withTenant(
      tenantId,
      async (db) => {
        try {
          const now = new Date();
          const orgFields = {
            first_name: firstName,
            last_name: lastName,
            designation_id: dto.designationId ?? null,
            department_id: dto.departmentId ?? null,
            location_id: dto.locationId ?? null,
            reporting_manager_id: dto.managerId ?? null,
            // Pre-fills from the Invite form — the wizard lets the employee
            // edit them later but admins typically know phone + DOB up front.
            ...(dto.personalPhone ? { personal_phone: dto.personalPhone } : {}),
            ...(dto.dateOfBirth ? { date_of_birth: dto.dateOfBirth } : {}),
            // Employment terms set by HR at hire time. noticePeriodDays keys
            // on !== undefined so an explicit 0 sticks; omitted → column
            // default (30) on create, unchanged on re-invite / re-hire.
            ...(dto.probationEndDate ? { probation_end_date: dto.probationEndDate } : {}),
            ...(dto.noticePeriodDays !== undefined
              ? { notice_period_days: dto.noticePeriodDays }
              : {}),
          };

          const employmentType =
            (dto.employmentType as typeof employees.$inferInsert['employment_type']) ??
            'full_time';

          let employee: typeof employees.$inferSelect;
          let seatAction: 'inserted' | 'reinvited' | 'linked' | 'kept' = 'kept';

          if (plan.mode === 'create') {
            const [created] = await db
              .insert(employees)
              .values({
                tenant_id: tenantId,
                user_id: currentUser.id,
                employee_code: plan.employeeCode,
                work_email: normalizedEmail,
                ...orgFields,
                employment_type: employmentType,
                date_of_joining: joiningDate,
                status: 'inactive',
                custom_fields: {
                  onboarding_step: 0,
                  ...(dto.jobTitle ? { job_title: dto.jobTitle } : {}),
                },
              })
              .returning();
            employee = created!;
          } else {
            // Re-invite (pending) or re-hire (archived): the SAME row, so the
            // person's id, history and — for a re-hire — personal, bank and
            // statutory columns all survive.
            const existingCustom =
              (plan.byEmail!.customFields as Record<string, unknown> | null) ?? {};
            const [updated] = await db
              .update(employees)
              .set({
                ...orgFields,
                // A re-invite that omits these keeps what HR entered the
                // first time; a re-hire is a new stint, so its joining date
                // is the form's (or today — the same date the rehire history
                // row and shift assignment use).
                ...(dto.employmentType !== undefined ? { employment_type: employmentType } : {}),
                ...(plan.mode === 'rehire' || dto.joiningDate
                  ? { date_of_joining: joiningDate }
                  : {}),
                employee_code: plan.employeeCode,
                user_id: currentUser.id,
                status: 'inactive',
                deleted_at: null,
                updated_at: now,
                custom_fields:
                  plan.mode === 'rehire'
                    ? {
                        ...existingCustom,
                        onboarding_step: 0,
                        onboarding_submitted_for_review: false,
                        onboarding_rejection_reason: null,
                        onboarding_deferred_at: null,
                        // The previous stint's wizard timestamps would
                        // otherwise show as "submitted" on /me.
                        onboarding_completed_at: null,
                        onboarding_submitted_at: null,
                        onboarding_rejected_at: null,
                        ...(dto.jobTitle ? { job_title: dto.jobTitle } : {}),
                      }
                    : {
                        ...existingCustom,
                        ...(dto.jobTitle ? { job_title: dto.jobTitle } : {}),
                      },
              })
              .where(and(eq(employees.id, plan.byEmail!.id), eq(employees.tenant_id, tenantId)))
              .returning();
            employee = updated!;

            if (plan.mode === 'rehire') {
              await db.insert(employmentHistory).values({
                tenant_id: tenantId,
                employee_id: employee.id,
                change_type: 'rehire',
                effective_from: joiningDate,
                previous_value: {
                  status: plan.byEmail!.status,
                  deletedAt: plan.byEmail!.deletedAt,
                  employeeCode: plan.byEmail!.employeeCode,
                },
                new_value: { status: 'inactive', employeeCode: plan.employeeCode },
                changed_by: adminId,
              });
            }
          }

          // The Add-employee form's shift pick finally lands somewhere: without
          // this row the attendance engine silently ran everyone on the tenant
          // default shift, so lateness and worked hours were wrong for anyone
          // hired onto another shift (founder round A).
          if (dto.shiftTemplateId) {
            await this.writeShiftAssignment(db, tenantId, employee.id, dto.shiftTemplateId, joiningDate);
          }

          // ─── The seat ──────────────────────────────────────────────────
          // Re-read by the user that now owns the row (the precheck looked it
          // up by the same id; the re-read keeps this tx self-contained).
          const [seat] = await db
            .select()
            .from(memberships)
            .where(
              and(
                eq(memberships.tenant_id, tenantId),
                eq(memberships.user_id, currentUser.id),
              ),
            )
            .orderBy(asc(memberships.created_at))
            .limit(1);

          if (!seat) {
            await db.insert(memberships).values({
              tenant_id: tenantId,
              user_id: currentUser.id,
              employee_id: employee.id,
              role: 'employee',
              status: 'invited',
              invited_by: adminId,
              invited_at: now,
            });
            seatAction = 'inserted';
          } else if (seat.status === 'deactivated') {
            // Revoked by a prior removal (or from Settings → Members): this
            // is a fresh hire, so the seat starts over as an invited
            // employee and the magic link activates it (handleSuccessfulAuth).
            await db
              .update(memberships)
              .set({
                status: 'invited',
                employee_id: employee.id,
                role: 'employee',
                invited_by: adminId,
                invited_at: now,
                accepted_at: null,
              })
              .where(and(eq(memberships.id, seat.id), eq(memberships.tenant_id, tenantId)));
            seatAction = 'reinvited';
          } else if (seat.employee_id !== employee.id) {
            // Active or invited seat with no (or a stale) record behind it —
            // keep role + status, just link it so every "me" surface works.
            await db
              .update(memberships)
              .set({ employee_id: employee.id })
              .where(and(eq(memberships.id, seat.id), eq(memberships.tenant_id, tenantId)));
            seatAction = 'linked';
          }

          // Resolve tenant name for the email template.
          const [tenantRow] = await db
            .select({ name: tenants.name })
            .from(tenants)
            .where(eq(tenants.id, tenantId))
            .limit(1);
          const companyName = tenantRow?.name ?? 'Your Company';

          return { employee, companyName, seatAction };
        } catch (err) {
          this.rethrowInviteWriteError(err, plan.employeeCode);
        }
      },
    );

    // A corrected name on a re-invite should show up in the directory (it
    // reads users.full_name). Only while the person has never signed in —
    // users is a platform row shared across workspaces.
    if (plan.mode !== 'create' && dto.fullName.trim()) {
      await this.dbAdmin
        .update(users)
        .set({ full_name: dto.fullName.trim(), updated_at: new Date() })
        .where(and(eq(users.id, currentUser.id), isNull(users.last_login_at)));
    }

    // Generate a 7-day magic link so the invitee can sign in with one click,
    // bypassing the OTP flow. The link routes through /verify → /auth/magic-link
    // which calls handleSuccessfulAuth — and that activates their 'invited'
    // membership before issuing the session cookies. Outside the tenant tx.
    const link = await this.issueInviteLink(currentUser.id, normalizedEmail);

    const resentCount = await this.databaseService.withTenant(tenantId, async (db) => {
      if (plan.mode === 'reinvite') {
        // Same double-submit guard as resendInvite: the 60 s window was
        // checked in the read-only precheck; re-check it under the lock
        // before the ledger row goes in so two in-flight submits send once.
        await db.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`employee_invite:${employee.id}`}))`,
        );
        await this.assertResendWindow(db, tenantId, employee.id);
      }
      return this.writeInvitationLedger(db, {
        tenantId,
        employeeId: employee.id,
        email: normalizedEmail,
        tokenHash: link.tokenHash,
        expiresAt: link.expiresAt,
        invitedBy: adminId,
      });
    });

    // Send welcome email with the magic link as the primary CTA. sendEmail
    // never throws; a false is surfaced as emailSent so the UI can say so.
    const emailSent =
      (await this.notificationsService.sendEmail('welcome-employee', normalizedEmail, {
        employeeName: dto.fullName,
        companyName,
        magicLinkUrl: link.url,
        ...(plan.mode === 'reinvite' ? { isReminder: true } : {}),
      })) !== false;

    await this.auditService.log({
      tenantId,
      actorUserId: adminId,
      action:
        plan.mode === 'rehire'
          ? 'employee.rehired'
          : plan.mode === 'reinvite'
            ? 'employee.invite_resent'
            : 'employee.invited',
      resourceType: 'employee',
      resourceId: employee.id,
      afterState: {
        email: normalizedEmail,
        employeeCode: employee.employee_code,
        seat: seatAction,
        resentCount,
        emailSent,
      },
    });

    if (plan.mode === 'rehire') {
      // The restored row just reappeared in every directory.
      this.eventEmitter.emit('employees.directory.changed', { tenantId });
    }

    this.logger.log(
      `Employee ${plan.mode === 'create' ? 'invited' : plan.mode === 'reinvite' ? 're-invited' : 're-hired'}: ${normalizedEmail} (${employee.id})`,
    );

    // Return safe response (no sensitive fields)
    return {
      id: employee.id,
      employeeCode: employee.employee_code,
      designationId: employee.designation_id,
      userId: employee.user_id,
      email: normalizedEmail,
      fullName: dto.fullName,
      status: employee.status,
      joiningDate: employee.date_of_joining,
      ...(plan.mode === 'reinvite' ? { reinvited: true } : {}),
      ...(plan.mode === 'rehire' ? { rehired: true } : {}),
      emailSent,
    };
  }

  // ─── Bulk CSV import (PRD §5.5) ────────────────────────────────────────
  // Resolves department/designation/location NAMES to ids, then reuses the
  // single-invite path per row so every row goes through the same validation,
  // membership creation, and welcome email. Per-row failures are collected,
  // not fatal — a bad row never blocks the good ones.
  async importEmployees(
    dto: ImportEmployeesDto,
    adminId: string,
    tenantId: string,
  ) {
    const norm = (s: string) => s.trim().toLowerCase();

    const [depts, desigs, locs] = await this.databaseService.withTenant(
      tenantId,
      (db) =>
        Promise.all([
          db
            .select({ id: departments.id, name: departments.name })
            .from(departments)
            .where(eq(departments.tenant_id, tenantId)),
          db
            .select({ id: designations.id, title: designations.title })
            .from(designations)
            .where(eq(designations.tenant_id, tenantId)),
          db
            .select({ id: locations.id, name: locations.name })
            .from(locations)
            .where(eq(locations.tenant_id, tenantId)),
        ]),
    );
    const deptMap = new Map(depts.map((d) => [norm(d.name), d.id]));
    const desigMap = new Map(desigs.map((d) => [norm(d.title), d.id]));
    const locMap = new Map(locs.map((l) => [norm(l.name), l.id]));

    let created = 0;
    const failed: Array<{ row: number; email: string; error: string }> = [];
    // Round P (R1.2): rows that match someone still waiting on their invite
    // are skipped, not re-mailed — a CSV re-upload must never mass-resend.
    const skipped: Array<{ row: number; email: string; reason: string }> = [];

    for (let i = 0; i < dto.rows.length; i++) {
      const r = dto.rows[i];
      try {
        if (r.department && !deptMap.has(norm(r.department))) {
          throw new Error(`Unknown department "${r.department}"`);
        }
        if (r.designation && !desigMap.has(norm(r.designation))) {
          throw new Error(`Unknown designation "${r.designation}"`);
        }
        if (r.location && !locMap.has(norm(r.location))) {
          throw new Error(`Unknown location "${r.location}"`);
        }
        await this.inviteEmployee(
          {
            fullName: r.fullName,
            email: r.email,
            employeeCode: r.employeeCode,
            departmentId: r.department ? deptMap.get(norm(r.department)) : undefined,
            designationId: r.designation ? desigMap.get(norm(r.designation)) : undefined,
            locationId: r.location ? locMap.get(norm(r.location)) : undefined,
            employmentType: r.employmentType,
            joiningDate: r.joiningDate,
            jobTitle: r.jobTitle,
          },
          adminId,
          tenantId,
          { onPendingInvitee: 'skip' },
        );
        created += 1;
      } catch (e) {
        if (e instanceof PendingInviteeSkipped) {
          skipped.push({ row: i + 1, email: r.email, reason: e.message });
          continue;
        }
        failed.push({
          row: i + 1,
          email: r.email,
          error: e instanceof Error ? e.message : 'Failed to import',
        });
      }
    }

    await this.auditService.log({
      tenantId,
      actorUserId: adminId,
      action: 'employee.bulk_imported',
      resourceType: 'employee',
      resourceId: tenantId,
      metadata: {
        total: dto.rows.length,
        created,
        failed: failed.length,
        skipped: skipped.length,
      },
    });

    return { total: dto.rows.length, created, failed, skipped };
  }

  // ─── Resend invite (Round P / R1.1) ──────────────────────────────────────

  /**
   * Who is still waiting on their invite: a live row, status 'inactive', not
   * yet submitted for review, with a seat that is not deactivated (a missing
   * seat is self-healed by resendInvite). Someone who opened the link but
   * stopped mid-wizard (seat 'active', step > 0) is still eligible.
   */
  private async listResendEligible(db: Db, tenantId: string) {
    return db
      .select({ id: employees.id, email: employees.work_email })
      .from(employees)
      .where(
        and(
          eq(employees.tenant_id, tenantId),
          isNull(employees.deleted_at),
          eq(employees.status, 'inactive'),
          sql`${ONBOARDING_SUBMITTED_SQL} = false`,
          sql`${MEMBERSHIP_STATUS_SQL} IS DISTINCT FROM 'deactivated'`,
        ),
      )
      .orderBy(asc(employees.created_at));
  }

  /**
   * Re-send the welcome email with a fresh 7-day link. Earlier links keep
   * working (tokens are per user). tx1 checks eligibility + the 60 s window,
   * the link is issued outside any tenant tx, tx2 writes the ledger row (and
   * self-heals a missing seat / user link), then the email + audit.
   */
  async resendInvite(employeeId: string, tenantId: string, actorId: string) {
    const ctx = await this.databaseService.withTenant(tenantId, async (db) => {
      const [emp] = await db
        .select({
          id: employees.id,
          userId: employees.user_id,
          firstName: employees.first_name,
          lastName: employees.last_name,
          workEmail: employees.work_email,
          status: employees.status,
          deletedAt: employees.deleted_at,
          customFields: employees.custom_fields,
        })
        .from(employees)
        .where(and(eq(employees.id, employeeId), eq(employees.tenant_id, tenantId)))
        .limit(1);
      if (!emp) throw new NotFoundException('Employee not found');

      const name = `${emp.firstName} ${emp.lastName}`.trim() || emp.workEmail;
      if (emp.deletedAt) {
        throw new ConflictException({
          code: 'EMPLOYEE_REMOVED',
          message: 'This person was removed — restore them from People → Removed first',
        });
      }
      const custom = (emp.customFields as Record<string, unknown> | null) ?? {};
      if (emp.status !== 'inactive' || custom.onboarding_submitted_for_review === true) {
        throw new ConflictException({
          code: 'ALREADY_ONBOARDED',
          message: `${name} has already accepted their invite and submitted onboarding`,
        });
      }

      // The seat: by employee_id (how invites link it), else by user_id.
      const [byEmployee] = await db
        .select()
        .from(memberships)
        .where(
          and(eq(memberships.tenant_id, tenantId), eq(memberships.employee_id, emp.id)),
        )
        .limit(1);
      const [byUser] = !byEmployee && emp.userId
        ? await db
            .select()
            .from(memberships)
            .where(
              and(eq(memberships.tenant_id, tenantId), eq(memberships.user_id, emp.userId)),
            )
            .orderBy(asc(memberships.created_at))
            .limit(1)
        : [];
      const seat = byEmployee ?? byUser ?? null;
      if (seat?.status === 'deactivated') {
        throw new ConflictException({
          code: 'SEAT_DEACTIVATED',
          message:
            'Their workspace seat is deactivated — reactivate them from Settings → Members first',
        });
      }
      // A seat already behind ANOTHER live record is not stolen by a resend.
      const seatHeldElsewhere = seat
        ? await this.seatHeldByAnotherLiveRow(db, tenantId, seat, emp.id)
        : false;

      await this.assertResendWindow(db, tenantId, emp.id);

      const [tenantRow] = await db
        .select({ name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      return {
        emp,
        name,
        seat,
        seatHeldElsewhere,
        companyName: tenantRow?.name ?? 'Your Company',
      };
    });

    // Self-heal a legacy row with no platform user behind it (service role —
    // the person may exist in another workspace already).
    const user = ctx.emp.userId
      ? { id: ctx.emp.userId }
      : await this.findOrCreateInviteUser(ctx.emp.workEmail, ctx.name);

    // Outside the tenant tx (admin pool insert into auth_otps).
    const link = await this.issueInviteLink(user.id, ctx.emp.workEmail);

    const { resentCount, seatHealed } = await this.databaseService.withTenant(
      tenantId,
      async (db) => {
        // Serialise concurrent resends for one employee (double-click): the
        // window is re-checked under the lock before the ledger row goes in.
        await db.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`employee_invite:${ctx.emp.id}`}))`,
        );
        await this.assertResendWindow(db, tenantId, ctx.emp.id);

        if (!ctx.emp.userId) {
          await db
            .update(employees)
            .set({ user_id: user.id, updated_at: new Date() })
            .where(and(eq(employees.id, ctx.emp.id), eq(employees.tenant_id, tenantId)));
        }

        let seatHealed = false;
        if (!ctx.seat) {
          await db.insert(memberships).values({
            tenant_id: tenantId,
            user_id: user.id,
            employee_id: ctx.emp.id,
            role: 'employee',
            status: 'invited',
            invited_by: actorId,
            invited_at: new Date(),
          });
          seatHealed = true;
        } else if (ctx.seat.employee_id !== ctx.emp.id && !ctx.seatHeldElsewhere) {
          await db
            .update(memberships)
            .set({ employee_id: ctx.emp.id })
            .where(and(eq(memberships.id, ctx.seat.id), eq(memberships.tenant_id, tenantId)));
          seatHealed = true;
        }

        const resentCount = await this.writeInvitationLedger(db, {
          tenantId,
          employeeId: ctx.emp.id,
          email: ctx.emp.workEmail,
          tokenHash: link.tokenHash,
          expiresAt: link.expiresAt,
          invitedBy: actorId,
        });
        return { resentCount, seatHealed };
      },
    );

    const emailSent =
      (await this.notificationsService.sendEmail('welcome-employee', ctx.emp.workEmail, {
        employeeName: ctx.name,
        companyName: ctx.companyName,
        magicLinkUrl: link.url,
        isReminder: true,
      })) !== false;

    await this.auditService.log({
      tenantId,
      actorUserId: actorId,
      action: 'employee.invite_resent',
      resourceType: 'employee',
      resourceId: ctx.emp.id,
      afterState: { email: ctx.emp.workEmail, resentCount, emailSent, seatHealed },
    });

    this.logger.log(`Invite re-sent: ${ctx.emp.workEmail} (${ctx.emp.id}) #${resentCount}`);

    return {
      data: {
        employeeId: ctx.emp.id,
        email: ctx.emp.workEmail,
        resentCount,
        emailSent,
      },
    };
  }

  /**
   * Resend to a list of employees, or to everyone still waiting when the list
   * is omitted. Per-row outcome, never fatal: throttled / ineligible / failed
   * rows land in `skipped` with the API's own message as the reason.
   */
  async resendInvitesBulk(tenantId: string, actorId: string, employeeIds?: string[]) {
    const targets = await this.databaseService.withTenant(tenantId, async (db) => {
      // OMITTED = everyone still waiting. An explicit empty list (a bulk
      // action with nothing selected) mails nobody — never a mass re-send
      // by accident.
      if (employeeIds === undefined) return this.listResendEligible(db, tenantId);
      if (employeeIds.length === 0) return [];
      const rows = await db
        .select({ id: employees.id, email: employees.work_email })
        .from(employees)
        .where(and(eq(employees.tenant_id, tenantId), inArray(employees.id, employeeIds)));
      const byId = new Map(rows.map((r) => [r.id, r.email]));
      // Keep the caller's order; unknown ids are reported, not dropped.
      return employeeIds.map((id) => ({ id, email: byId.get(id) ?? '' }));
    });

    let sent = 0;
    const skipped: Array<{ employeeId: string; email: string; reason: string }> = [];
    for (const t of targets) {
      try {
        const res = await this.resendInvite(t.id, tenantId, actorId);
        if (res.data.emailSent) sent += 1;
        else skipped.push({ employeeId: t.id, email: t.email, reason: 'Email could not be sent' });
      } catch (e) {
        if (e instanceof HttpException) {
          skipped.push({ employeeId: t.id, email: t.email, reason: e.message });
          continue;
        }
        throw e;
      }
    }

    return { data: { sent, skipped } };
  }

  // ─── Next employee code (Round P / R1.3) ─────────────────────────────────

  /**
   * The next free code in the workspace's OWN pattern: parse every code —
   * REMOVED rows included, they still hold the unique index — as
   * (prefix)(number), continue the dominant prefix at its digit width, and
   * step past anything already taken.
   */
  async suggestNextEmployeeCode(tenantId: string) {
    const codes = await this.databaseService.withTenant(tenantId, (db) =>
      db
        .select({ code: employees.employee_code })
        .from(employees)
        .where(eq(employees.tenant_id, tenantId)),
    );
    const taken = new Set(codes.map((c) => c.code.trim().toUpperCase()));

    const parsed = codes
      .map((c) => /^(.*?)(\d+)$/.exec(c.code.trim()))
      .filter((m): m is RegExpExecArray => m !== null);

    let prefix = 'EMP';
    let next = 1;
    let width = 3;
    if (parsed.length > 0) {
      const byPrefix = new Map<string, { count: number; max: number; width: number }>();
      for (const m of parsed) {
        const p = m[1]!;
        const num = parseInt(m[2]!, 10);
        const entry = byPrefix.get(p) ?? { count: 0, max: 0, width: 3 };
        entry.count += 1;
        if (num >= entry.max) {
          entry.max = num;
          entry.width = m[2]!.length;
        }
        byPrefix.set(p, entry);
      }
      // Most-used prefix wins; ties break toward the highest sequence number
      // (≈ most recently issued).
      const [bestPrefix, info] = [...byPrefix.entries()].sort(
        (a, b) => b[1].count - a[1].count || b[1].max - a[1].max,
      )[0]!;
      prefix = bestPrefix;
      next = info.max + 1;
      width = info.width;
    }

    let suggested = `${prefix}${String(next).padStart(width, '0')}`;
    // Mixed schemes can leave the arithmetic next already in use — walk on.
    for (let guard = 0; guard < 10_000 && taken.has(suggested.toUpperCase()); guard++) {
      next += 1;
      suggested = `${prefix}${String(next).padStart(width, '0')}`;
    }
    return { data: { suggested } };
  }

  async getEmployee(employeeId: string, tenantId: string) {
    return this.databaseService.withTenant(tenantId, async (db) => {
      // Self-join alias for the reporting manager (manager is also an employee).
      const manager = alias(employees, 'manager');
      const managerUser = alias(users, 'manager_user');

      // ─── Core profile with all joins ──────────────────────────────────────
      const [row] = await db
        .select({
          // Identity
          id: employees.id,
          employeeCode: employees.employee_code,
          firstName: employees.first_name,
          middleName: employees.middle_name,
          lastName: employees.last_name,
          preferredName: employees.preferred_name,
          // Email / phone
          workEmail: employees.work_email,
          personalEmail: employees.personal_email,
          workPhone: employees.work_phone,
          personalPhone: employees.personal_phone,
          // FKs + joined names
          userId: employees.user_id,
          departmentId: employees.department_id,
          departmentName: departments.name,
          designationId: employees.designation_id,
          designationTitle: designations.title,
          designationLevel: designations.level,
          locationId: employees.location_id,
          locationName: locations.name,
          locationCity: locations.city,
          locationTimezone: locations.timezone,
          locationCountryCode: locations.country_code,
          reportingManagerId: employees.reporting_manager_id,
          reportingManagerName: managerUser.full_name,
          reportingManagerEmail: managerUser.email,
          // Employment
          employmentType: employees.employment_type,
          dateOfJoining: employees.date_of_joining,
          dateOfConfirmation: employees.date_of_confirmation,
          probationEndDate: employees.probation_end_date,
          dateOfExit: employees.date_of_exit,
          noticePeriodDays: employees.notice_period_days,
          // Personal
          dateOfBirth: employees.date_of_birth,
          gender: employees.gender,
          maritalStatus: employees.marital_status,
          nationality: employees.nationality,
          bloodGroup: employees.blood_group,
          currentAddress: employees.current_address,
          permanentAddress: employees.permanent_address,
          // Statutory (encrypted columns surfaced as flags only)
          hasPan: sql<boolean>`${employees.pan_encrypted} IS NOT NULL`,
          hasPassport: sql<boolean>`${employees.passport_number_encrypted} IS NOT NULL`,
          aadhaarLast4: employees.aadhaar_last4,
          pfUan: employees.pf_uan,
          esicNumber: employees.esic_number,
          pfApplicable: employees.pf_applicable,
          esiApplicable: employees.esi_applicable,
          // Banking (account number encrypted; show last-4 + bank name + ifsc)
          bankName: employees.bank_name,
          bankBranch: employees.bank_branch,
          bankIfsc: employees.bank_ifsc,
          bankAccountType: employees.bank_account_type,
          bankAccountHolder: employees.bank_account_holder,
          hasBankAccount: sql<boolean>`${employees.bank_account_number_encrypted} IS NOT NULL`,
          // Status + avatar
          status: employees.status,
          avatarUrl: sql<string | null>`COALESCE(${employees.avatar_url}, ${users.avatar_url})`,
          avatarKey: users.avatar_key,
          customFields: employees.custom_fields,
          // Round P (R1.3): same three fields the directory list carries, so
          // the 360 header shows the same pill as the row that opened it.
          membershipStatus: MEMBERSHIP_STATUS_SQL,
          onboardingStep: ONBOARDING_STEP_SQL,
          onboardingSubmitted: ONBOARDING_SUBMITTED_SQL,
          createdAt: employees.created_at,
          updatedAt: employees.updated_at,
          // Linked user identity
          userFullName: users.full_name,
          userEmail: users.email,
          // Keep snake_case mirrors of the columns that other service methods
          // already reference, so this rewrite stays a non-breaking enrichment.
          custom_fields: employees.custom_fields,
          user_id: employees.user_id,
        })
        .from(employees)
        .leftJoin(users, eq(employees.user_id, users.id))
        .leftJoin(departments, eq(employees.department_id, departments.id))
        .leftJoin(designations, eq(employees.designation_id, designations.id))
        .leftJoin(locations, eq(employees.location_id, locations.id))
        .leftJoin(manager, eq(employees.reporting_manager_id, manager.id))
        .leftJoin(managerUser, eq(manager.user_id, managerUser.id))
        .where(
          and(eq(employees.id, employeeId), eq(employees.tenant_id, tenantId)),
        )
        .limit(1);

      if (!row) {
        throw new NotFoundException('Employee not found');
      }

      // ─── Sibling collections ──────────────────────────────────────────────
      const [emergencyList, leaveBalanceRows, monthStats, shiftRows] = await Promise.all([
        // Emergency contacts (primary first, oldest first within a tie — the
        // same row the self-service / onboarding upserts write to).
        db
          .select({
            id: emergencyContacts.id,
            name: emergencyContacts.name,
            relationship: emergencyContacts.relationship,
            phone: emergencyContacts.phone,
            email: emergencyContacts.email,
            isPrimary: emergencyContacts.is_primary,
          })
          .from(emergencyContacts)
          .where(
            and(
              eq(emergencyContacts.tenant_id, tenantId),
              eq(emergencyContacts.employee_id, employeeId),
            ),
          )
          .orderBy(desc(emergencyContacts.is_primary), asc(emergencyContacts.created_at)),

        // Leave balances for the current year (with type metadata).
        // Falls back to leave_types.default_quota_days when no balance row
        // exists yet — matches the leave service's own getMyBalances shape.
        db
          .select({
            leaveTypeId: leaveTypes.id,
            leaveTypeName: leaveTypes.name,
            code: leaveTypes.code,
            color: leaveTypes.color,
            defaultQuotaDays: leaveTypes.default_quota_days,
            opening: leaveBalances.opening_balance,
            accrued: leaveBalances.accrued,
            used: leaveBalances.used,
            pending: leaveBalances.pending,
            available: leaveBalances.available,
          })
          .from(leaveTypes)
          .leftJoin(
            leaveBalances,
            and(
              eq(leaveBalances.leave_type_id, leaveTypes.id),
              eq(leaveBalances.employee_id, employeeId),
              eq(leaveBalances.leave_year, new Date().getFullYear()),
            ),
          )
          .where(
            and(
              eq(leaveTypes.tenant_id, tenantId),
              eq(leaveTypes.is_active, true),
              // Gender-scoped: untagged types for everyone; tagged types only
              // when THIS employee's gender matches (mirrors leave service).
              or(
                isNull(leaveTypes.applicable_genders),
                sql`(SELECT e.gender::text FROM employees e WHERE e.id = ${employeeId} AND e.tenant_id = ${tenantId}) = ANY(${leaveTypes.applicable_genders})`,
              ),
            ),
          )
          .orderBy(asc(leaveTypes.display_order)),

        // 'This month' attendance summary — single row aggregate
        db
          .select({
            daysPresent: sql<number>`COUNT(*) FILTER (WHERE ${attendanceRecords.attendance_status} IN ('present','late','work_from_home','on_duty'))::int`,
            lateArrivals: sql<number>`COUNT(*) FILTER (WHERE ${attendanceRecords.is_late} = true)::int`,
            minutesWorked: sql<number>`COALESCE(SUM(${attendanceRecords.total_worked_minutes}),0)::int`,
            onLeave: sql<number>`COUNT(*) FILTER (WHERE ${attendanceRecords.attendance_status} = 'on_leave')::int`,
          })
          .from(attendanceRecords)
          .where(
            and(
              eq(attendanceRecords.tenant_id, tenantId),
              eq(attendanceRecords.employee_id, employeeId),
              sql`${attendanceRecords.attendance_date} >= date_trunc('month', current_date)::date`,
              sql`${attendanceRecords.attendance_date} <= current_date`,
            ),
          ),

        // Shift effective TODAY (round A). Null → the tenant default applies;
        // mirrors attendance's resolveShiftTemplate so the profile shows the
        // same shift the lateness math actually uses.
        db
          .select({
            shiftTemplateId: employeeShifts.shift_template_id,
            name: shiftTemplates.name,
            startTime: shiftTemplates.start_time,
            endTime: shiftTemplates.end_time,
            effectiveFrom: employeeShifts.effective_from,
          })
          .from(employeeShifts)
          .innerJoin(shiftTemplates, eq(employeeShifts.shift_template_id, shiftTemplates.id))
          .where(
            and(
              eq(employeeShifts.tenant_id, tenantId),
              eq(employeeShifts.employee_id, employeeId),
              sql`${employeeShifts.effective_from} <= current_date`,
              or(
                isNull(employeeShifts.effective_to),
                sql`${employeeShifts.effective_to} >= current_date`,
              ),
            ),
          )
          .orderBy(desc(employeeShifts.effective_from))
          .limit(1),
      ]);

      const month = monthStats[0] ?? {
        daysPresent: 0,
        lateArrivals: 0,
        minutesWorked: 0,
        onLeave: 0,
      };

      const { avatarKey, ...rest } = row;
      return {
        ...rest,
        // The photo lives in users.avatar_key (the upload path never writes
        // the legacy avatar_url columns), so resolve it to a signed URL here.
        avatarUrl: await this.mediaService.servedUrl(
          avatarKey ?? null,
          row.avatarUrl,
          256,
        ),
        // Synthesise the "this month" card from the aggregate.
        thisMonth: {
          daysPresent: Number(month.daysPresent ?? 0),
          lateArrivals: Number(month.lateArrivals ?? 0),
          hoursWorked: Math.round(Number(month.minutesWorked ?? 0) / 60),
          leaveTaken: Number(month.onLeave ?? 0),
        },
        currentShift: shiftRows[0] ?? null,
        emergencyContacts: emergencyList,
        leaveBalances: leaveBalanceRows.map((b) => ({
          leaveTypeId: b.leaveTypeId,
          leaveTypeName: b.leaveTypeName,
          code: b.code,
          color: b.color,
          opening: Number(b.opening ?? b.defaultQuotaDays ?? 0),
          accrued: Number(b.accrued ?? 0),
          used: Number(b.used ?? 0),
          pending: Number(b.pending ?? 0),
          available: Number(b.available ?? b.defaultQuotaDays ?? 0),
        })),
      };
    });
  }

  async getMyRecord(userId: string, tenantId: string) {
    const membership = await this.databaseService.withTenant(tenantId, (db) =>
      db
        .select({ employeeId: memberships.employee_id })
        .from(memberships)
        .where(
          and(
            eq(memberships.user_id, userId),
            eq(memberships.tenant_id, tenantId),
          ),
        )
        .limit(1),
    );

    if (!membership[0]?.employeeId) {
      throw new NotFoundException('Employee record not found');
    }

    return this.getEmployee(membership[0].employeeId, tenantId);
  }

  async listMyTeam(userId: string, tenantId: string) {
    return this.databaseService.withTenant(tenantId, async (db) => {
      const [membership] = await db
        .select({ employeeId: memberships.employee_id })
        .from(memberships)
        .where(
          and(
            eq(memberships.user_id, userId),
            eq(memberships.tenant_id, tenantId),
          ),
        )
        .limit(1);
      if (!membership?.employeeId) {
        // User has no employee row (e.g. plain admin user) → empty team.
        return { data: [], total: 0 };
      }

      const managerEmployeeId = membership.employeeId;

      const rows = await db
        .select({
          id: employees.id,
          employeeCode: employees.employee_code,
          firstName: employees.first_name,
          lastName: employees.last_name,
          fullName: sql<string>`COALESCE(${employees.first_name}, '') || ' ' || COALESCE(${employees.last_name}, '')`,
          workEmail: employees.work_email,
          status: employees.status,
          employmentType: employees.employment_type,
          dateOfJoining: employees.date_of_joining,
          // Joined names
          departmentId: employees.department_id,
          departmentName: departments.name,
          designationId: employees.designation_id,
          designationTitle: designations.title,
          locationId: employees.location_id,
          locationName: locations.name,
          avatarUrl: sql<string | null>`COALESCE(${employees.avatar_url}, ${users.avatar_url})`,
          avatarKey: users.avatar_key,
          userId: employees.user_id, // D9 presence keying
          // Submitted-for-review flag — managers should see which of their
          // reports have finished self-onboarding.
          onboardingComplete: sql<boolean>`(${employees.custom_fields}->>'onboarding_submitted_for_review')::boolean`,
        })
        .from(employees)
        .leftJoin(users, eq(employees.user_id, users.id))
        .leftJoin(departments, eq(employees.department_id, departments.id))
        .leftJoin(designations, eq(employees.designation_id, designations.id))
        .leftJoin(locations, eq(employees.location_id, locations.id))
        .where(
          and(
            eq(employees.tenant_id, tenantId),
            eq(employees.reporting_manager_id, managerEmployeeId),
            // Round I: same people the manager dashboard counts — removed
            // (round 21) and separated staff are not "direct reports".
            isNull(employees.deleted_at),
            inArray(employees.status, ['active', 'notice_period', 'on_leave']),
          ),
        )
        .orderBy(asc(employees.first_name));

      const data = await this.withAvatars(rows);
      return {
        managerEmployeeId,
        data,
        total: data.length,
      };
    });
  }

  async updateEmployee(
    employeeId: string,
    dto: UpdateEmployeeDto,
    adminId: string,
    tenantId: string,
  ) {
    const employee = await this.getEmployee(employeeId, tenantId);

    const empPatch: Partial<typeof employees.$inferInsert> = {
      updated_at: new Date(),
    };

    if (dto.fullName !== undefined) {
      const parts = dto.fullName.trim().split(/\s+/);
      empPatch.first_name = parts[0] ?? dto.fullName;
      empPatch.last_name = parts.length > 1 ? parts.slice(1).join(' ') : '';
    }
    if (dto.workPhone !== undefined) empPatch.work_phone = dto.workPhone;
    if (dto.personalPhone !== undefined)
      empPatch.personal_phone = dto.personalPhone;
    if (dto.designationId !== undefined)
      empPatch.designation_id = dto.designationId;
    if (dto.employeeCode !== undefined)
      empPatch.employee_code = dto.employeeCode.trim().toUpperCase();
    if (dto.departmentId !== undefined) empPatch.department_id = dto.departmentId;
    if (dto.locationId !== undefined) empPatch.location_id = dto.locationId;
    if (dto.reportingManagerId !== undefined)
      empPatch.reporting_manager_id = dto.reportingManagerId;
    if (dto.employmentType !== undefined)
      empPatch.employment_type = dto.employmentType as typeof employees.$inferInsert.employment_type;
    if (dto.dateOfJoining !== undefined)
      empPatch.date_of_joining = dto.dateOfJoining;
    if (dto.probationEndDate !== undefined)
      empPatch.probation_end_date = dto.probationEndDate;
    if (dto.dateOfConfirmation !== undefined)
      empPatch.date_of_confirmation = dto.dateOfConfirmation;
    if (dto.noticePeriodDays !== undefined)
      empPatch.notice_period_days = dto.noticePeriodDays;

    const updated = await this.databaseService.withTenant(
      tenantId,
      async (db) => {
        // Reject cross-tenant / dangling org refs before writing them.
        await this.assertOrgRefsInTenant(db, tenantId, {
          departmentId: dto.departmentId,
          designationId: dto.designationId,
          locationId: dto.locationId,
          managerEmployeeId: dto.reportingManagerId,
          shiftTemplateId: dto.shiftTemplateId,
        });
        if (dto.reportingManagerId !== undefined && dto.reportingManagerId === employeeId) {
          throw new BadRequestException('An employee cannot report to themselves');
        }

        // Shift change takes effect today; null reverts to the tenant default.
        if (dto.shiftTemplateId !== undefined) {
          const today = new Date().toISOString().split('T')[0]!;
          await this.writeShiftAssignment(db, tenantId, employeeId, dto.shiftTemplateId, today);
        }

        const [updated] = await db
          .update(employees)
          .set(empPatch)
          .where(eq(employees.id, employeeId))
          .returning()
          .catch((err: unknown) => {
            // employees_tenant_code_unique — duplicate code in this workspace.
            if ((err as { code?: string })?.code === '23505') {
              throw new ConflictException(
                'That employee code is already in use in this workspace.',
              );
            }
            throw err;
          });

        // Name + avatar live on the user record, shared across memberships.
        if (
          employee.userId &&
          (dto.fullName !== undefined || dto.avatarUrl !== undefined)
        ) {
          await db
            .update(users)
            .set({
              ...(dto.fullName !== undefined ? { full_name: dto.fullName } : {}),
              ...(dto.avatarUrl !== undefined ? { avatar_url: dto.avatarUrl } : {}),
              updated_at: new Date(),
            })
            .where(eq(users.id, employee.userId));
        }

        return updated;
      },
    );

    await this.auditService.log({
      tenantId,
      actorUserId: adminId,
      action: 'employee.updated',
      resourceType: 'employee',
      resourceId: employeeId,
      beforeState: {
        firstName: employee.firstName,
        lastName: employee.lastName,
        workPhone: employee.workPhone,
        personalPhone: employee.personalPhone,
        designationId: employee.designationId,
        employeeCode: employee.employeeCode,
        departmentId: employee.departmentId,
        locationId: employee.locationId,
        reportingManagerId: employee.reportingManagerId,
        employmentType: employee.employmentType,
        dateOfJoining: employee.dateOfJoining,
        probationEndDate: employee.probationEndDate,
        dateOfConfirmation: employee.dateOfConfirmation,
        noticePeriodDays: employee.noticePeriodDays,
      },
      afterState: {
        fullName: dto.fullName,
        workPhone: dto.workPhone,
        personalPhone: dto.personalPhone,
        designationId: dto.designationId,
        employeeCode: dto.employeeCode,
        departmentId: dto.departmentId,
        locationId: dto.locationId,
        reportingManagerId: dto.reportingManagerId,
        employmentType: dto.employmentType,
        dateOfJoining: dto.dateOfJoining,
        probationEndDate: dto.probationEndDate,
        dateOfConfirmation: dto.dateOfConfirmation,
        noticePeriodDays: dto.noticePeriodDays,
        ...(dto.shiftTemplateId !== undefined
          ? { shiftTemplateId: dto.shiftTemplateId }
          : {}),
      },
    });

    return updated;
  }

  /**
   * Swaps `avatarKey` for a signed URL on a row set, falling back to the
   * legacy `avatarUrl` column. Every avatar-bearing read goes through this —
   * the upload path writes `users.avatar_key` only, so a surface that reads
   * the legacy column alone shows initials forever.
   */
  private async withAvatars<
    T extends { avatarKey?: string | null; avatarUrl?: string | null },
  >(rows: T[], size: 256 | 64 = 64): Promise<Omit<T, 'avatarKey'>[]> {
    return Promise.all(
      rows.map(async ({ avatarKey, ...row }) => ({
        ...(row as Omit<T, 'avatarKey'>),
        avatarUrl: await this.mediaService.servedUrl(
          avatarKey ?? null,
          (row as { avatarUrl?: string | null }).avatarUrl ?? null,
          size,
        ),
      })),
    );
  }

  /**
   * Reads the caller's and the target employee's membership roles inside the
   * tenant transaction. Roles are never taken from the client — the same
   * rationale as submitOnboardingStep's actor lookup.
   *
   * The target is resolved by employee_id, not user_id: an invited employee
   * has employees.user_id = NULL until they accept.
   */
  private async loadReviewRoles(
    tenantId: string,
    employeeId: string,
    callerUserId: string,
  ) {
    return this.databaseService.withTenant(tenantId, async (db) => {
      const [target] = await db
        .select({ role: memberships.role })
        .from(memberships)
        .where(
          and(
            eq(memberships.tenant_id, tenantId),
            eq(memberships.employee_id, employeeId),
          ),
        )
        .limit(1);
      const [caller] = await db
        .select({ role: memberships.role })
        .from(memberships)
        .where(
          and(
            eq(memberships.tenant_id, tenantId),
            eq(memberships.user_id, callerUserId),
          ),
        )
        .limit(1);
      // If a workspace has no active owner (ownership handed over, owner
      // deactivated) the owner-only rule would strand every pending admin
      // with nobody able to approve them — house rule 8. Admins may act then.
      const [owner] = await db
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.tenant_id, tenantId),
            eq(memberships.status, 'active'),
            eq(memberships.role, 'owner'),
          ),
        )
        .limit(1);
      return {
        targetRole: target?.role ?? null,
        callerRole: caller?.role ?? null,
        hasActiveOwner: !!owner,
      };
    });
  }

  /**
   * Founder round 18: an HR admin's own onboarding is the owner's to sign off.
   * A peer admin must not approve or send back a colleague's file — they hold
   * the same powers, so it would be self-review by proxy.
   */
  private assertMayReviewTarget(roles: {
    targetRole: string | null;
    callerRole: string | null;
    hasActiveOwner: boolean;
  }) {
    // Owner targets are gated too: a second owner must not be signed off by
    // an admin either.
    const seniorTarget =
      roles.targetRole === 'admin' || roles.targetRole === 'owner';
    if (!seniorTarget) return;
    if (roles.callerRole === 'owner') return;
    if (!roles.hasActiveOwner) return; // nobody senior exists — see above
    throw new ForbiddenException(
      "An HR admin's onboarding can only be reviewed by an owner.",
    );
  }

  /**
   * Round Q: approve / send back act ONLY on someone still waiting — not
   * joined yet (`inactive`), submitted, not removed, seat not switched off.
   * Before this, an off-boarded person resurfaced as "waiting for approval"
   * (the flag outlives approval) and Approve flipped them — and their sign-in
   * — back on. The row is locked so an off-board can't interleave.
   */
  private async lockPendingOnboardingTx(db: Db, tenantId: string, employeeId: string) {
    const [row] = await db
      .select({
        id: employees.id,
        status: employees.status,
        deleted_at: employees.deleted_at,
        custom_fields: employees.custom_fields,
        first_name: employees.first_name,
        last_name: employees.last_name,
      })
      .from(employees)
      .where(and(eq(employees.id, employeeId), eq(employees.tenant_id, tenantId)))
      .limit(1)
      .for('update');
    if (!row) throw new NotFoundException('Employee not found');
    const name = `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() || 'This person';
    const flag = (row.custom_fields as Record<string, unknown> | null)?.onboarding_submitted_for_review;
    if (row.deleted_at || row.status !== 'inactive' || (flag !== true && flag !== 'true')) {
      throw new ConflictException({
        code: 'NOT_PENDING',
        message: `${name} is no longer waiting for onboarding approval.`,
      });
    }
    const [seat] = await db
      .select({ status: memberships.status })
      .from(memberships)
      .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.employee_id, employeeId)))
      .limit(1);
    if (seat?.status === 'deactivated') {
      throw new ConflictException({
        code: 'SEAT_DEACTIVATED',
        message: `${name}'s access was switched off in Settings → Members — reactivate it there first.`,
      });
    }
    return row;
  }

  async getOnboardingQueue(tenantId: string, callerUserId: string) {
    const rows = await this.databaseService.withTenant(tenantId, async (db) => {
      const [caller] = await db
        .select({ role: memberships.role })
        .from(memberships)
        .where(
          and(
            eq(memberships.tenant_id, tenantId),
            eq(memberships.user_id, callerUserId),
          ),
        )
        .limit(1);
      const callerIsOwner = caller?.role === 'owner';
      const [activeOwner] = await db
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.tenant_id, tenantId),
            eq(memberships.status, 'active'),
            eq(memberships.role, 'owner'),
          ),
        )
        .limit(1);
      // No owner to review them ⇒ don't hide the rows from admins.
      const ownerOnly = !callerIsOwner && !!activeOwner;

      return db
        .select({
          id: employees.id,
          employeeCode: employees.employee_code,
          fullName: users.full_name,
          email: users.email,
          avatarUrl: users.avatar_url,
          avatarKey: users.avatar_key,
          designationTitle: designations.title,
          departmentName: departments.name,
          status: employees.status,
          // Lets the UI mark whose file this is; also what the owner-only
          // rule keys on.
          memberRole: memberships.role,
          submittedAt: sql<string | null>`${employees.custom_fields}->>'onboarding_submitted_at'`,
          // Round Q: set once the 24-hour onboarding escalation has fired.
          escalatedAt: sql<string | null>`${employees.custom_fields}->>'onboarding_escalated_at'`,
        })
        .from(employees)
        .leftJoin(users, eq(employees.user_id, users.id))
        .leftJoin(designations, eq(employees.designation_id, designations.id))
        .leftJoin(departments, eq(employees.department_id, departments.id))
        // By employee_id — an invited employee has no user_id yet. Deliberately
        // NOT filtered on membership status: a pending admin's seat is still
        // 'invited'.
        .leftJoin(
          memberships,
          and(
            eq(memberships.employee_id, employees.id),
            eq(memberships.tenant_id, tenantId),
          ),
        )
        .where(
          and(
            eq(employees.tenant_id, tenantId),
            sql`(${employees.custom_fields}->>'onboarding_submitted_for_review')::boolean = true`,
            // Round Q: ONLY people who have not joined yet. The flag is never
            // cleared on approval, so `status <> 'active'` brought every
            // approved person back the moment they were off-boarded (notice /
            // separated) — "waiting for approval, 37d ago" — and Approve then
            // reactivated them. Removed (archived) rows never belong here.
            eq(employees.status, 'inactive'),
            isNull(employees.deleted_at),
            // Nobody reviews their own profile — hide the caller's row (a
            // second owner would otherwise see and approve himself). IS
            // DISTINCT FROM keeps invited rows (user_id NULL) visible.
            sql`${employees.user_id} IS DISTINCT FROM ${callerUserId}`,
            // Round 18: only an owner sees an HR admin's file. isNull keeps
            // rows with no membership yet (ordinary joiners) visible.
            ownerOnly
              ? or(
                  isNull(memberships.role),
                  and(
                    ne(memberships.role, 'admin'),
                    ne(memberships.role, 'owner'),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(asc(employees.created_at));
    });

    const data = await this.withAvatars(rows);
    return { data, total: data.length };
  }

  async rejectOnboarding(
    employeeId: string,
    reason: string | undefined,
    adminId: string,
    tenantId: string,
  ) {
    const employee = await this.getEmployee(employeeId, tenantId);

    if (employee.userId && employee.userId === adminId) {
      throw new ForbiddenException(
        'You cannot review your own onboarding — another admin must approve or send it back.',
      );
    }

    this.assertMayReviewTarget(
      await this.loadReviewRoles(tenantId, employeeId, adminId),
    );

    // Clear the review flag so the employee can edit + resubmit, and record
    // the reason in custom_fields for the wizard to surface.
    const user = await this.databaseService.withTenant(
      tenantId,
      async (db) => {
        // Round Q: only someone still waiting may be sent back. The merge
        // base is the locked row, not the read made before the tx.
        const locked = await this.lockPendingOnboardingTx(db, tenantId, employeeId);
        const existing = (locked.custom_fields ?? {}) as Record<string, unknown>;
        await db
          .update(employees)
          .set({
            custom_fields: {
              ...existing,
              onboarding_submitted_for_review: false,
              onboarding_rejection_reason: reason ?? null,
              onboarding_rejected_at: new Date().toISOString(),
              // A resubmission starts a fresh 24-hour clock.
              onboarding_escalated_at: null,
              onboarding_escalated_to: null,
            },
            updated_at: new Date(),
          })
          .where(and(eq(employees.id, employeeId), eq(employees.tenant_id, tenantId)));

        if (!employee.userId) return null;
        const [u] = await db
          .select({ email: users.email, full_name: users.full_name })
          .from(users)
          .where(eq(users.id, employee.userId))
          .limit(1);
        return u ?? null;
      },
    );

    if (employee.userId && user) {
      // Detached (round C): best-effort; the reviewer's CTA shouldn't wait.
      void this.notificationsService.createInAppNotification(
        employee.userId,
        'onboarding.rejected',
        reason
          ? `Your onboarding was sent back for changes: ${reason}`
          : 'Your onboarding was sent back for changes. Please review and resubmit.',
        // The wizard's real route — /employees/me/onboarding never existed.
        '/onboarding/employee',
        tenantId,
      );

      const appUrl = this.configService.get<string>('APP_URL', 'http://localhost:3000');
      void this.notificationsService
        .sendEmail('onboarding-rejected', user.email, {
          employeeName: user.full_name,
          reason,
          resubmitUrl: `${appUrl}/onboarding/employee`,
        })
        .catch(() => undefined);
    }

    await this.auditService.log({
      tenantId,
      actorUserId: adminId,
      action: 'employee.onboarding.rejected',
      resourceType: 'employee',
      resourceId: employeeId,
      metadata: { reason: reason ?? null },
    });

    // Every other admin's queue/inbox just changed — broadcast the refresh.
    this.eventEmitter.emit('employees.directory.changed', { tenantId });

    return { employeeId, status: employee.status, rejectedBy: adminId };
  }

  /**
   * Self-service profile edit (founder round K) — contact details only.
   * One tenant transaction resolves the caller's employee row from their
   * ACTIVE membership, writes personal phone / email, merges the current
   * address and upserts (or, with `emergencyContact: null`, removes) the
   * primary emergency contact. Nothing HR-managed is reachable from here:
   * name, work email, designation and role live on UpdateEmployeeDto behind
   * @Roles('admin').
   *
   * Deliberately does NOT mirror users.phone: users is a platform table
   * (no tenant_id), so a write there changed the person's number in every
   * workspace they belong to. employees.personal_phone is the single owner.
   */
  async selfUpdateEmployee(
    userId: string,
    dto: SelfUpdateEmployeeDto,
    tenantId: string,
  ) {
    // '' (or whitespace) clears; everything else is stored trimmed.
    const clean = (v: string | null | undefined): string | null => {
      const t = (v ?? '').trim();
      return t ? t : null;
    };

    const { employeeId, fields } = await this.databaseService.withTenant(
      tenantId,
      async (db) => {
        const [membership] = await db
          .select({ employeeId: memberships.employee_id })
          .from(memberships)
          .where(
            and(
              eq(memberships.user_id, userId),
              eq(memberships.tenant_id, tenantId),
              eq(memberships.status, 'active'),
            ),
          )
          .limit(1);

        const [employee] = membership?.employeeId
          ? await db
              .select({
                id: employees.id,
                currentAddress: employees.current_address,
              })
              .from(employees)
              .where(
                and(
                  eq(employees.id, membership.employeeId),
                  eq(employees.tenant_id, tenantId),
                  isNull(employees.deleted_at),
                ),
              )
              .limit(1)
          : [];

        if (!employee) {
          throw new NotFoundException(
            'No employee record is linked to your seat — ask HR',
          );
        }

        // Audit records WHICH sections changed, never the values.
        const fields: string[] = [];
        const set: Partial<typeof employees.$inferInsert> = {};

        if (dto.personalPhone !== undefined) {
          set.personal_phone = clean(dto.personalPhone);
          fields.push('personalPhone');
        }
        if (dto.personalEmail !== undefined) {
          set.personal_email = clean(dto.personalEmail)?.toLowerCase() ?? null;
          fields.push('personalEmail');
        }
        // current_address is a JSONB blob keyed like submitOnboardingStep
        // writes it: merge over what's there, keep country + untouched keys.
        if (dto.currentAddress) {
          const a = dto.currentAddress;
          const prev =
            (employee.currentAddress as Record<string, unknown> | null) ?? {};
          const pick = (next: string | undefined, current: unknown) =>
            next === undefined ? (current ?? null) : clean(next);
          const merged = {
            ...prev,
            line1: pick(a.line1, prev.line1),
            line2: pick(a.line2, prev.line2),
            city: pick(a.city, prev.city),
            state: pick(a.stateCode, prev.state),
            postal_code: pick(a.postalCode, prev.postal_code),
            country: prev.country ?? 'IN',
          };
          // Blanking every line must read back as "no address" (—), not as
          // a country-only blob that renders as a bare "IN".
          const blank = (['line1', 'line2', 'city', 'state', 'postal_code'] as const).every(
            (k) => merged[k] == null,
          );
          set.current_address = blank ? null : merged;
          fields.push('currentAddress');
        }

        if (Object.keys(set).length > 0) {
          await db
            .update(employees)
            .set({ ...set, updated_at: new Date() })
            .where(
              and(
                eq(employees.id, employee.id),
                eq(employees.tenant_id, tenantId),
              ),
            );
        }

        // ─── Emergency contact: the (oldest) primary row is the one we own ──
        if (dto.emergencyContact !== undefined) {
          const ownRow = and(
            eq(emergencyContacts.tenant_id, tenantId),
            eq(emergencyContacts.employee_id, employee.id),
          );
          const [primary] = await db
            .select({ id: emergencyContacts.id })
            .from(emergencyContacts)
            .where(and(ownRow, eq(emergencyContacts.is_primary, true)))
            .orderBy(asc(emergencyContacts.created_at))
            .limit(1);

          if (dto.emergencyContact === null) {
            if (primary) {
              await db
                .delete(emergencyContacts)
                .where(and(ownRow, eq(emergencyContacts.id, primary.id)));
            }
          } else {
            const c = dto.emergencyContact;
            const name = clean(c.name);
            const relationship = clean(c.relationship);
            const phone = clean(c.phone);
            if (!name || !relationship || !phone) {
              throw new BadRequestException(
                'Emergency contact needs a name, relationship and phone',
              );
            }
            const values = {
              name,
              relationship,
              phone,
              email: clean(c.email)?.toLowerCase() ?? null,
            };
            if (primary) {
              await db
                .update(emergencyContacts)
                .set(values)
                .where(and(ownRow, eq(emergencyContacts.id, primary.id)));
            } else {
              await db.insert(emergencyContacts).values({
                tenant_id: tenantId,
                employee_id: employee.id,
                ...values,
                is_primary: true,
              });
            }
          }
          fields.push('emergencyContact');
        }

        return { employeeId: employee.id, fields };
      },
      userId,
    );

    if (fields.length > 0) {
      await this.auditService.log({
        tenantId,
        actorUserId: userId,
        action: 'employee.self_updated',
        resourceType: 'employee',
        resourceId: employeeId,
        metadata: { fields },
      });
    }

    return this.getEmployee(employeeId, tenantId);
  }

  async submitOnboardingStep(
    employeeId: string,
    step: number,
    data: SubmitOnboardingStepDto,
    tenantId: string,
    actorUserId: string,
    ctx?: { ip?: string; userAgent?: string; isAdminEdit?: boolean },
  ) {
    const employee = await this.getEmployee(employeeId, tenantId);

    const existingCustom =
      (employee.custom_fields as Record<string, unknown> | null) ?? {};
    const currentStep =
      typeof existingCustom.onboarding_step === 'number'
        ? existingCustom.onboarding_step
        : 0;
    const nextStep = Math.max(currentStep, step);
    // Admin edits (the "Edit details" dialog / confirmed change requests)
    // must never re-trigger review submission: for an already-onboarded
    // employee onboarding_step sticks at 5, so without this guard any admin
    // tab-save recomputed allStepsComplete=true, flipped
    // onboarding_submitted_for_review back on and re-emailed the manager.
    const isAdminEdit = ctx?.isAdminEdit === true;
    const allStepsComplete =
      !isAdminEdit && (nextStep >= 5 || data.submitForReview === true);

    // ─── Project section data into typed employee columns ────────────────
    const updateFields: Record<string, unknown> = {};

    if (data.personalInfo) {
      const p = data.personalInfo;
      if (p.dateOfBirth !== undefined) updateFields.date_of_birth = p.dateOfBirth;
      if (p.gender !== undefined) updateFields.gender = p.gender;
      if (p.maritalStatus !== undefined)
        updateFields.marital_status = p.maritalStatus;
      if (p.bloodGroup !== undefined) updateFields.blood_group = p.bloodGroup;
      // current_address is a JSONB blob. Merge with whatever's already there.
      if (
        p.addressLine1 !== undefined ||
        p.addressLine2 !== undefined ||
        p.city !== undefined ||
        p.stateCode !== undefined ||
        p.postalCode !== undefined
      ) {
        const prev =
          (employee.currentAddress as Record<string, unknown> | null) ?? {};
        updateFields.current_address = {
          line1: p.addressLine1 ?? prev.line1 ?? null,
          line2: p.addressLine2 ?? prev.line2 ?? null,
          city: p.city ?? prev.city ?? null,
          state: p.stateCode ?? prev.state ?? null,
          postal_code: p.postalCode ?? prev.postal_code ?? null,
          country: prev.country ?? 'IN',
        };
      }
    }

    if (data.identity) {
      const i = data.identity;
      if (i.pan !== undefined)
        updateFields.pan_encrypted = this.fieldCipher.encrypt(i.pan);
      if (i.aadhaarLast4 !== undefined)
        updateFields.aadhaar_last4 = i.aadhaarLast4;
      if (i.passportNumber !== undefined)
        updateFields.passport_number_encrypted = this.fieldCipher.encrypt(
          i.passportNumber,
        );
      if (i.personalPhone !== undefined)
        updateFields.personal_phone = i.personalPhone;
      if (i.personalEmail !== undefined)
        updateFields.personal_email = i.personalEmail;
      if (i.nationality !== undefined) updateFields.nationality = i.nationality;
    }

    if (data.bank) {
      const b = data.bank;
      if (b.bankName !== undefined) updateFields.bank_name = b.bankName;
      if (b.bankBranch !== undefined) updateFields.bank_branch = b.bankBranch;
      if (b.bankIfsc !== undefined) updateFields.bank_ifsc = b.bankIfsc;
      if (b.bankAccountType !== undefined)
        updateFields.bank_account_type = b.bankAccountType;
      if (b.bankAccountHolder !== undefined)
        updateFields.bank_account_holder = b.bankAccountHolder;
      if (b.bankAccountNumber !== undefined)
        updateFields.bank_account_number_encrypted = this.fieldCipher.encrypt(
          b.bankAccountNumber,
        );
      if (b.pfUan !== undefined) updateFields.pf_uan = b.pfUan;
    }

    if (!isAdminEdit) {
      updateFields.custom_fields = {
        ...existingCustom,
        onboarding_step: nextStep,
        onboarding_completed_at: allStepsComplete ? new Date().toISOString() : null,
        onboarding_submitted_for_review: allStepsComplete,
        ...(allStepsComplete
          ? {
              onboarding_submitted_at: new Date().toISOString(),
              // Round P: an owner/admin who "skipped for now" and then
              // finished the wizard is no longer deferred.
              onboarding_deferred_at: null,
            }
          : {}),
      };
    }
    updateFields.updated_at = new Date();

    // Owner self-service completion (founder round 17): when the person
    // finishing the wizard IS the owner, there is nobody senior to review
    // them — complete + activate directly and skip the reviewer fan-out.
    // Derived from the caller's membership role inside the tx; a client flag
    // can never trigger it. HR admins deliberately keep the review path —
    // the owner signs their file off (founder round 17.1).
    let selfServeCompletion = false;
    let actorRole: string | null = null;

    await this.databaseService.withTenant(tenantId, async (db) => {
      if (allStepsComplete) {
        const [actor] = await db
          .select({ role: memberships.role })
          .from(memberships)
          .where(
            and(
              eq(memberships.tenant_id, tenantId),
              eq(memberships.user_id, actorUserId),
            ),
          )
          .limit(1);
        actorRole = actor?.role ?? null;
        selfServeCompletion =
          actor?.role === 'owner' && employee.user_id === actorUserId;
        if (selfServeCompletion) {
          // No reviewer will ever approve them into 'active' — do it here.
          updateFields.status = 'active';
        }
      }

      await db
        .update(employees)
        .set(updateFields)
        .where(eq(employees.id, employeeId));

      if (selfServeCompletion) {
        // Also activate the membership (an owner seat can still be 'invited'
        // if ownership was handed over before they finished); idempotent for
        // an already-active founder.
        await db
          .update(memberships)
          .set({
            status: 'active',
            accepted_at: sql`COALESCE(${memberships.accepted_at}, now())`,
          })
          .where(
            and(
              eq(memberships.tenant_id, tenantId),
              eq(memberships.employee_id, employeeId),
            ),
          );
      }

      // ─── Emergency contact: upsert the primary row ─────────────────────
      if (data.emergencyContact) {
        const ec = data.emergencyContact;
        const [existing] = await db
          .select()
          .from(emergencyContacts)
          .where(
            and(
              eq(emergencyContacts.tenant_id, tenantId),
              eq(emergencyContacts.employee_id, employeeId),
              eq(emergencyContacts.is_primary, true),
            ),
          )
          // Oldest primary wins — deterministic when legacy data left two.
          .orderBy(asc(emergencyContacts.created_at))
          .limit(1);

        if (existing) {
          await db
            .update(emergencyContacts)
            .set({
              name: ec.name,
              relationship: ec.relationship,
              phone: ec.phone,
              email: ec.email ?? null,
            })
            .where(eq(emergencyContacts.id, existing.id));
        } else {
          await db.insert(emergencyContacts).values({
            tenant_id: tenantId,
            employee_id: employeeId,
            name: ec.name,
            relationship: ec.relationship,
            phone: ec.phone,
            email: ec.email ?? null,
            is_primary: true,
          });
        }
      }

      // ─── DPDP consents ─────────────────────────────────────────────────
      // Record each granted/withheld consent as its own immutable row, with
      // the policy version + IP + UA for the audit trail. We re-grant on
      // every submit that carries consents (idempotent enough for the MVP —
      // the rows are timestamped so the latest one wins on read).
      if (data.consents?.length) {
        const now = new Date();
        await db.insert(dataConsents).values(
          data.consents.map((c) => ({
            tenant_id: tenantId,
            user_id: actorUserId,
            consent_type: c.type as
              | 'data_processing'
              | 'marketing'
              | 'background_check'
              | 'biometric_data'
              | 'third_party_sharing',
            purpose: c.purpose ?? null,
            granted: c.granted,
            consent_version: CONSENT_VERSION,
            ip_address: ctx?.ip ?? null,
            user_agent: ctx?.userAgent ?? null,
            granted_at: c.granted ? now : null,
          })),
        );
      }
    });

    await this.auditService.log({
      tenantId,
      actorUserId,
      action: selfServeCompletion
        ? 'employee.onboarding_completed'
        : allStepsComplete
          ? 'employee.onboarding_submitted'
          : isAdminEdit
            ? 'employee.details_admin_saved'
            : 'employee.onboarding_step_saved',
      resourceType: 'employee',
      resourceId: employeeId,
      afterState: {
        step: nextStep,
        allStepsComplete,
        selfActivated: selfServeCompletion,
        consentsRecorded: data.consents?.length ?? 0,
      },
    });

    if (allStepsComplete) {
      // Tenant-wide "employees data changed" broadcast (queue rows appear on
      // every admin's screen without a reload) — self-serve completions too:
      // activation changes the directory.
      this.eventEmitter.emit('employees.directory.changed', { tenantId });
    }

    if (allStepsComplete && !selfServeCompletion) {
      // Notify reviewers (best-effort): the reporting manager by email, and
      // every active owner/admin in-app — EXCLUDING the submitter (a second
      // owner must never be invited to review their own profile). The
      // People → Onboarding queue is the canonical surface. Owner/admin
      // self-serve completions notify nobody — there is nothing to review.
      // Stays awaited (round C looked at detaching it): submit fires once
      // per employee ever, and four review-flow specs pin the synchronous
      // fan-out — not a CTA worth loosening.
      try {
        const info = await this.databaseService.withTenant(
          tenantId,
          async (db) => {
            const mgr = alias(employees, 'mgr_submit');
            const mgrUser = alias(users, 'mgr_submit_user');
            const [info] = await db
              .select({
                employeeName: sql<string>`trim(coalesce(${employees.first_name},'') || ' ' || coalesce(${employees.last_name},''))`,
                managerEmail: mgrUser.email,
                managerName: mgrUser.full_name,
                // Round Q: can the manager act on it? Only Owner / HR seats
                // approve onboarding — everyone else gets an FYI, not a
                // "Review" button into a page that answers 403.
                managerSeatRole: sql<string | null>`(SELECT m.role::text FROM memberships m WHERE m.tenant_id = ${tenantId} AND m.user_id = ${mgr.user_id} AND m.status = 'active' LIMIT 1)`,
              })
              .from(employees)
              .leftJoin(mgr, eq(employees.reporting_manager_id, mgr.id))
              .leftJoin(mgrUser, eq(mgr.user_id, mgrUser.id))
              .where(eq(employees.id, employeeId))
              .limit(1);
            return info;
          },
        );

        if (info?.managerEmail) {
          const appUrl = this.configService.get<string>('APP_URL', 'http://localhost:3000');
          await this.notificationsService.sendEmail(
            'onboarding-submitted',
            info.managerEmail,
            {
              approverName: info.managerName ?? 'there',
              employeeName: info.employeeName || 'A new hire',
              reviewUrl: `${appUrl}/employees/onboarding?employee=${employeeId}`,
              fyi: !['owner', 'admin'].includes(info.managerSeatRole ?? ''),
            },
          );
        }

        // In-app ping for every active owner/admin except the submitter.
        // dbAdmin (memberships are cross-tenant-invisible under RLS at this
        // point) — tenant predicate is mandatory.
        //
        // An HR admin's OWN onboarding goes to the owners: a peer admin
        // shouldn't sign off their colleague's file (founder round 17.1).
        // Falls back to the full pool if the workspace has no active owner,
        // so the request can never land nowhere.
        const findReviewers = (roles: Array<'owner' | 'admin'>) =>
          this.dbAdmin
            .select({ userId: memberships.user_id })
            .from(memberships)
            .where(
              and(
                eq(memberships.tenant_id, tenantId),
                eq(memberships.status, 'active'),
                inArray(memberships.role, roles),
                ne(memberships.user_id, actorUserId),
              ),
            );
        // An admin's own file is the owners' to review (round 18), so it is
        // pointless — and now a guaranteed 403 — to ping peer admins about it.
        const submitterIsAdmin = actorRole === 'admin';
        let reviewers = await findReviewers(
          submitterIsAdmin ? ['owner'] : ['owner', 'admin'],
        );
        // No active owner ⇒ admins both may and must review (see
        // assertMayReviewTarget), so tell them.
        if (!reviewers.length && submitterIsAdmin)
          reviewers = await findReviewers(['owner', 'admin']);
        const recipientIds = [...new Set(reviewers.map((r) => r.userId))];
        for (const reviewerId of recipientIds) {
          await this.notificationsService.createInAppNotification(
            reviewerId,
            'onboarding.submitted',
            `${info?.employeeName || 'A new hire'} submitted onboarding for review.`,
            // Deep link straight into the review dialog for THIS employee —
            // a bare queue URL left reviewers with nothing to act on.
            `/employees/onboarding?employee=${employeeId}`,
            tenantId,
            { groupKey: `onboarding:${employeeId}` },
          );
        }
      } catch (e) {
        this.logger.warn(
          `Could not send onboarding-submitted notifications: ${(e as Error).message}`,
        );
      }
    }

    return {
      employeeId,
      step,
      onboardingStep: nextStep,
      allStepsComplete,
      selfServeCompletion,
    };
  }

  // ─── Admin detail edits → employee confirmation (change requests) ─────────
  // HR/Owner edits to an ACTIVE, app-joined employee's personal/identity/bank
  // details are held as a pending change request until the employee confirms
  // (or rejects) them — nothing touches the record behind their back. For
  // employees who haven't joined yet (invited / still onboarding) there is
  // nobody to confirm, so the edit applies directly as before.

  private maskTail(value: string): string {
    return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`;
  }

  /** Builds the masked old→new display summary for a change request. */
  private buildChangeSummary(
    employee: Record<string, unknown>,
    dto: SubmitOnboardingStepDto,
  ): Array<{ field: string; from: string | null; to: string }> {
    const rows: Array<{ field: string; from: string | null; to: string }> = [];
    const push = (field: string, from: unknown, to: unknown) => {
      if (to === undefined) return;
      rows.push({
        field,
        from: from == null || from === '' ? null : String(from),
        to: String(to),
      });
    };
    const p = dto.personalInfo;
    if (p) {
      const addr = (employee.currentAddress as Record<string, unknown>) ?? {};
      push('Date of birth', employee.dateOfBirth, p.dateOfBirth);
      push('Gender', employee.gender, p.gender);
      push('Marital status', employee.maritalStatus, p.maritalStatus);
      push('Blood group', employee.bloodGroup, p.bloodGroup);
      push('Address line 1', addr.line1, p.addressLine1);
      push('Address line 2', addr.line2, p.addressLine2);
      push('City', addr.city, p.city);
      push('State', addr.state, p.stateCode);
      push('Postal code', addr.postal_code, p.postalCode);
    }
    const i = dto.identity;
    if (i) {
      if (i.pan !== undefined)
        rows.push({
          field: 'PAN',
          from: employee.hasPan ? 'on file' : null,
          to: this.maskTail(i.pan),
        });
      if (i.passportNumber !== undefined)
        rows.push({
          field: 'Passport / ID number',
          from: employee.hasPassport ? 'on file' : null,
          to: this.maskTail(i.passportNumber),
        });
      push('Aadhaar (last 4)', employee.aadhaarLast4, i.aadhaarLast4);
      push('Personal phone', employee.personalPhone, i.personalPhone);
      push('Personal email', employee.personalEmail, i.personalEmail);
      push('Nationality', employee.nationality, i.nationality);
    }
    const b = dto.bank;
    if (b) {
      push('Bank name', employee.bankName, b.bankName);
      push('Branch', employee.bankBranch, b.bankBranch);
      if (b.bankAccountNumber !== undefined)
        rows.push({
          field: 'Account number',
          from: employee.hasBankAccount ? 'on file' : null,
          to: this.maskTail(b.bankAccountNumber),
        });
      push('Account holder', employee.bankAccountHolder, b.bankAccountHolder);
      push('IFSC', employee.bankIfsc, b.bankIfsc);
      push('Account type', employee.bankAccountType, b.bankAccountType);
      push('PF UAN', employee.pfUan, b.pfUan);
    }
    return rows;
  }

  /**
   * Entry point for the admin "Edit details" dialog. Decides between the
   * pending-confirmation flow (active, app-joined employee) and direct apply
   * (nobody to confirm yet).
   */
  async adminSubmitEmployeeDetails(
    employeeId: string,
    step: number,
    dto: SubmitOnboardingStepDto,
    tenantId: string,
    adminUserId: string,
    ctx?: { ip?: string; userAgent?: string },
  ) {
    const employee = await this.getEmployee(employeeId, tenantId);
    const confirmable = Boolean(employee.userId) && employee.status === 'active';

    if (!confirmable) {
      const result = await this.submitOnboardingStep(
        employeeId,
        step,
        { ...dto, submitForReview: undefined },
        tenantId,
        adminUserId,
        { ...ctx, isAdminEdit: true },
      );
      return { ...result, pendingConfirmation: false as const };
    }

    // Store the payload with sensitive values encrypted at rest; the masked
    // summary is what both sides see in the UI.
    const payload: Record<string, unknown> = { step };
    if (dto.personalInfo) payload.personalInfo = { ...dto.personalInfo };
    if (dto.identity) {
      payload.identity = {
        ...dto.identity,
        ...(dto.identity.pan !== undefined
          ? { pan: this.fieldCipher.encrypt(dto.identity.pan) }
          : {}),
        // Security audit 2026-10-06: the passport number rode the spread in
        // plain text and the payload is kept after review — encrypt it like
        // PAN and the bank account number.
        ...(dto.identity.passportNumber !== undefined && dto.identity.passportNumber !== null
          ? { passportNumber: this.fieldCipher.encrypt(String(dto.identity.passportNumber)) }
          : {}),
      };
    }
    if (dto.bank) {
      payload.bank = {
        ...dto.bank,
        ...(dto.bank.bankAccountNumber !== undefined
          ? { bankAccountNumber: this.fieldCipher.encrypt(dto.bank.bankAccountNumber) }
          : {}),
      };
    }
    const summary = this.buildChangeSummary(
      employee as unknown as Record<string, unknown>,
      dto,
    );
    if (summary.length === 0) {
      return { employeeId, step, pendingConfirmation: false as const };
    }

    const request = await this.databaseService.withTenant(
      tenantId,
      async (db) => {
        // One live request per employee+step: a re-save replaces the
        // previous pending values instead of stacking duplicates.
        await db
          .update(employeeChangeRequests)
          .set({ status: 'cancelled', reviewed_at: new Date() })
          .where(
            and(
              eq(employeeChangeRequests.tenant_id, tenantId),
              eq(employeeChangeRequests.employee_id, employeeId),
              eq(employeeChangeRequests.step, step),
              eq(employeeChangeRequests.status, 'pending'),
            ),
          );
        const [row] = await db
          .insert(employeeChangeRequests)
          .values({
            tenant_id: tenantId,
            employee_id: employeeId,
            requested_by_user_id: adminUserId,
            step,
            payload,
            summary,
          })
          .returning();
        return row;
      },
    );

    if (employee.userId) {
      // Detached (round C): best-effort; the save CTA shouldn't wait.
      void this.notificationsService.createInAppNotification(
        employee.userId as string,
        'employee.details_change_requested',
        'HR updated your details — please review and confirm the change.',
        '/profile',
        tenantId,
      );
    }

    await this.auditService.log({
      tenantId,
      actorUserId: adminUserId,
      action: 'employee.details_change_requested',
      resourceType: 'employee',
      resourceId: employeeId,
      afterState: { requestId: request!.id, step, fields: summary.map((s) => s.field) },
    });

    return {
      employeeId,
      step,
      pendingConfirmation: true as const,
      requestId: request!.id,
    };
  }

  /** Pending change requests for the calling employee (masked summary). */
  async listMyChangeRequests(userId: string, tenantId: string) {
    const employeeId = await this.getEmployeeIdForUserOrNull(userId, tenantId);
    if (!employeeId) return { requests: [] };
    const rows = await this.databaseService.withTenant(tenantId, (db) =>
      db
        .select({
          id: employeeChangeRequests.id,
          step: employeeChangeRequests.step,
          summary: employeeChangeRequests.summary,
          createdAt: employeeChangeRequests.created_at,
          requestedByName: users.full_name,
        })
        .from(employeeChangeRequests)
        .leftJoin(users, eq(employeeChangeRequests.requested_by_user_id, users.id))
        .where(
          and(
            eq(employeeChangeRequests.tenant_id, tenantId),
            eq(employeeChangeRequests.employee_id, employeeId),
            eq(employeeChangeRequests.status, 'pending'),
          ),
        )
        .orderBy(desc(employeeChangeRequests.created_at)),
    );
    return { requests: rows };
  }

  /** Employee decision on a pending request. Confirm applies; reject flags HR. */
  async reviewMyChangeRequest(
    userId: string,
    tenantId: string,
    requestId: string,
    action: 'confirm' | 'reject',
    reason?: string,
  ) {
    const employeeId = await this.getEmployeeIdForUserOrNull(userId, tenantId);
    if (!employeeId) throw new NotFoundException('Employee record not found');

    const request = await this.databaseService.withTenant(tenantId, async (db) => {
      const [row] = await db
        .select()
        .from(employeeChangeRequests)
        .where(
          and(
            eq(employeeChangeRequests.id, requestId),
            eq(employeeChangeRequests.tenant_id, tenantId),
            eq(employeeChangeRequests.employee_id, employeeId),
          ),
        )
        .limit(1);
      if (!row) throw new NotFoundException('Change request not found');
      if (row.status !== 'pending')
        throw new ConflictException('This change request was already reviewed');
      return row;
    });

    if (action === 'confirm') {
      // Decrypt sensitive values back into the step-writer's shape; the
      // writer re-encrypts them into the employee columns.
      const payload = request.payload as {
        personalInfo?: Record<string, unknown>;
        identity?: { pan?: string; passportNumber?: string } & Record<string, unknown>;
        bank?: { bankAccountNumber?: string } & Record<string, unknown>;
      };
      const dto: Record<string, unknown> = { step: request.step };
      if (payload.personalInfo) dto.personalInfo = payload.personalInfo;
      if (payload.identity) {
        dto.identity = {
          ...payload.identity,
          ...(payload.identity.pan !== undefined
            ? { pan: this.fieldCipher.decrypt(payload.identity.pan) }
            : {}),
          // decrypt() returns legacy plaintext rows (written before the
          // 2026-10-06 audit) unchanged, so old requests still apply.
          ...(typeof payload.identity.passportNumber === 'string'
            ? { passportNumber: this.fieldCipher.decrypt(payload.identity.passportNumber) }
            : {}),
        };
      }
      if (payload.bank) {
        dto.bank = {
          ...payload.bank,
          ...(payload.bank.bankAccountNumber !== undefined
            ? { bankAccountNumber: this.fieldCipher.decrypt(payload.bank.bankAccountNumber) }
            : {}),
        };
      }
      await this.submitOnboardingStep(
        employeeId,
        request.step,
        dto as unknown as SubmitOnboardingStepDto,
        tenantId,
        userId,
        { isAdminEdit: true },
      );
    }

    await this.databaseService.withTenant(tenantId, (db) =>
      db
        .update(employeeChangeRequests)
        .set({
          status: action === 'confirm' ? 'confirmed' : 'rejected',
          reason: reason ?? null,
          reviewed_at: new Date(),
        })
        .where(eq(employeeChangeRequests.id, requestId)),
    );

    if (request.requested_by_user_id) {
      const summary = (request.summary as Array<{ field: string }>) ?? [];
      const fields = summary.map((s) => s.field).slice(0, 3).join(', ');
      // Detached (round C): best-effort; the confirm CTA shouldn't wait.
      void this.notificationsService.createInAppNotification(
        request.requested_by_user_id,
        action === 'confirm'
          ? 'employee.details_change_confirmed'
          : 'employee.details_change_rejected',
        action === 'confirm'
          ? `Details change confirmed by the employee (${fields}).`
          : `Details change rejected by the employee${reason ? `: ${reason}` : ''} (${fields}).`,
        `/employees/${employeeId}`,
        tenantId,
      );
    }

    await this.auditService.log({
      tenantId,
      actorUserId: userId,
      action:
        action === 'confirm'
          ? 'employee.details_change_confirmed'
          : 'employee.details_change_rejected',
      resourceType: 'employee',
      resourceId: employeeId,
      metadata: { requestId, reason: reason ?? null },
    });

    return { requestId, status: action === 'confirm' ? 'confirmed' : 'rejected' };
  }

  /** Admin view of an employee's change requests (recent first). */
  async listEmployeeChangeRequests(employeeId: string, tenantId: string) {
    await this.getEmployee(employeeId, tenantId); // 404 for unknown/foreign ids
    const rows = await this.databaseService.withTenant(tenantId, (db) =>
      db
        .select({
          id: employeeChangeRequests.id,
          step: employeeChangeRequests.step,
          summary: employeeChangeRequests.summary,
          status: employeeChangeRequests.status,
          reason: employeeChangeRequests.reason,
          createdAt: employeeChangeRequests.created_at,
          reviewedAt: employeeChangeRequests.reviewed_at,
          requestedByName: users.full_name,
        })
        .from(employeeChangeRequests)
        .leftJoin(users, eq(employeeChangeRequests.requested_by_user_id, users.id))
        .where(
          and(
            eq(employeeChangeRequests.tenant_id, tenantId),
            eq(employeeChangeRequests.employee_id, employeeId),
          ),
        )
        .orderBy(desc(employeeChangeRequests.created_at))
        .limit(20),
    );
    return { requests: rows };
  }

  /** Admin withdraws a pending request before the employee acts on it. */
  async cancelChangeRequest(
    employeeId: string,
    requestId: string,
    tenantId: string,
    adminUserId: string,
  ) {
    const updated = await this.databaseService.withTenant(tenantId, (db) =>
      db
        .update(employeeChangeRequests)
        .set({ status: 'cancelled', reviewed_at: new Date() })
        .where(
          and(
            eq(employeeChangeRequests.id, requestId),
            eq(employeeChangeRequests.tenant_id, tenantId),
            eq(employeeChangeRequests.employee_id, employeeId),
            eq(employeeChangeRequests.status, 'pending'),
          ),
        )
        .returning({ id: employeeChangeRequests.id }),
    );
    if (updated.length === 0)
      throw new NotFoundException('No pending change request to cancel');
    await this.auditService.log({
      tenantId,
      actorUserId: adminUserId,
      action: 'employee.details_change_cancelled',
      resourceType: 'employee',
      resourceId: employeeId,
      metadata: { requestId },
    });
    return { cancelled: true };
  }

  async getMyOnboardingStatus(userId: string, tenantId: string) {
    const [seat] = await this.databaseService.withTenant(tenantId, (db) =>
      db
        .select({ employeeId: memberships.employee_id, role: memberships.role })
        .from(memberships)
        .where(
          and(eq(memberships.user_id, userId), eq(memberships.tenant_id, tenantId)),
        )
        .limit(1),
    );
    const employeeId = seat?.employeeId ?? null;
    // Round P: owners / HR admins may "Skip for now" (deferMyOnboarding);
    // the (app) layout stops redirecting to the wizard while `deferred`.
    const canDefer = !!employeeId && (seat?.role === 'owner' || seat?.role === 'admin');
    if (!employeeId) {
      return {
        employeeId: null,
        onboardingStep: 0,
        submittedAt: null,
        submittedForReview: false,
        deferred: false,
        canDefer: false,
      };
    }
    const employee = await this.getEmployee(employeeId, tenantId);
    const custom =
      (employee.customFields as Record<string, unknown> | null) ?? {};
    const submittedForReview = custom.onboarding_submitted_for_review === true;
    return {
      employeeId,
      onboardingStep:
        typeof custom.onboarding_step === 'number' ? custom.onboarding_step : 0,
      submittedAt: (custom.onboarding_completed_at as string | undefined) ?? null,
      submittedForReview,
      deferred: !!custom.onboarding_deferred_at && !submittedForReview,
      canDefer,
    };
  }

  /**
   * "Skip for now" (Round P / R1.6): an owner or HR admin may postpone their
   * own onboarding wizard. Stamps custom_fields.onboarding_deferred_at; the
   * wizard's completion clears it (submitOnboardingStep). The role comes from
   * the membership inside the tenant tx, never from the client.
   */
  async deferMyOnboarding(userId: string, tenantId: string) {
    const employeeId = await this.databaseService.withTenant(
      tenantId,
      async (db) => {
        const [seat] = await db
          .select({ employeeId: memberships.employee_id, role: memberships.role })
          .from(memberships)
          .where(
            and(eq(memberships.user_id, userId), eq(memberships.tenant_id, tenantId)),
          )
          .limit(1);
        if (seat?.role !== 'owner' && seat?.role !== 'admin') {
          throw new ForbiddenException(
            'Only an owner or HR admin can skip the onboarding wizard for now.',
          );
        }
        if (!seat.employeeId) {
          throw new NotFoundException('Employee record not found');
        }
        const [emp] = await db
          .select({ customFields: employees.custom_fields })
          .from(employees)
          .where(and(eq(employees.id, seat.employeeId), eq(employees.tenant_id, tenantId)))
          .limit(1);
        if (!emp) throw new NotFoundException('Employee record not found');
        const existing = (emp.customFields as Record<string, unknown> | null) ?? {};
        await db
          .update(employees)
          .set({
            custom_fields: {
              ...existing,
              onboarding_deferred_at: new Date().toISOString(),
            },
            updated_at: new Date(),
          })
          .where(and(eq(employees.id, seat.employeeId), eq(employees.tenant_id, tenantId)));
        return seat.employeeId;
      },
      userId,
    );

    await this.auditService.log({
      tenantId,
      actorUserId: userId,
      action: 'employee.onboarding_deferred',
      resourceType: 'employee',
      resourceId: employeeId,
    });

    return { data: { deferred: true } };
  }

  /** The caller's own employee row in this tenant (membership bridge), or null. */
  async getEmployeeIdForUserOrNull(userId: string, tenantId: string) {
    const [m] = await this.databaseService.withTenant(tenantId, (db) =>
      db
        .select({ employeeId: memberships.employee_id })
        .from(memberships)
        .where(
          and(eq(memberships.user_id, userId), eq(memberships.tenant_id, tenantId)),
        )
        .limit(1),
    );
    return m?.employeeId ?? null;
  }

  async approveOnboarding(
    employeeId: string,
    adminId: string,
    tenantId: string,
  ) {
    const employee = await this.getEmployee(employeeId, tenantId);

    if (employee.user_id && employee.user_id === adminId) {
      throw new ForbiddenException(
        'You cannot approve your own onboarding — another admin must review it.',
      );
    }

    this.assertMayReviewTarget(
      await this.loadReviewRoles(tenantId, employeeId, adminId),
    );

    const user = await this.databaseService.withTenant(
      tenantId,
      async (db) => {
        // Round Q: only someone still waiting may be approved — never an
        // off-boarded / removed person surfacing through a stale card.
        await this.lockPendingOnboardingTx(db, tenantId, employeeId);

        // Activate employee
        await db
          .update(employees)
          .set({ status: 'active', updated_at: new Date() })
          .where(and(eq(employees.id, employeeId), eq(employees.tenant_id, tenantId)));

        // Activate membership
        await db
          .update(memberships)
          .set({ status: 'active', accepted_at: new Date() })
          .where(
            and(
              eq(memberships.employee_id, employeeId),
              eq(memberships.tenant_id, tenantId),
            ),
          );

        // Get user email for notification
        if (!employee.user_id) return null;
        const [u] = await db
          .select({ email: users.email, full_name: users.full_name })
          .from(users)
          .where(eq(users.id, employee.user_id))
          .limit(1);
        return u ?? null;
      },
    );

    if (employee.user_id && user) {
      // Detached (round C): best-effort; the approve CTA shouldn't wait.
      void this.notificationsService.createInAppNotification(
        employee.user_id,
        'onboarding.approved',
        'Your onboarding was approved — your profile is now active. Welcome aboard!',
        '/dashboard',
        tenantId,
      );

      const loginUrl = this.configService.get<string>('APP_URL', 'http://localhost:3000');
      void this.notificationsService
        .sendEmail('onboarding-approved', user.email, {
          employeeName: user.full_name,
          loginUrl,
        })
        .catch(() => undefined);
    }

    await this.auditService.log({
      tenantId,
      actorUserId: adminId,
      action: 'employee.onboarding.approved',
      resourceType: 'employee',
      resourceId: employeeId,
    });

    // The approved employee just became visible in the directory/org chart —
    // push a tenant-wide refresh so every open screen updates live.
    this.eventEmitter.emit('employees.directory.changed', { tenantId });

    return { employeeId, status: 'active', approvedBy: adminId };
  }

  async transferEmployee(
    employeeId: string,
    dto: TransferEmployeeDto,
    adminId: string,
    tenantId: string,
  ) {
    const employee = await this.getEmployee(employeeId, tenantId);

    const previousValue = {
      departmentId: employee.departmentId,
      reportingManagerId: employee.reportingManagerId,
      locationId: employee.locationId,
      designationId: employee.designationId,
    };
    const newValue = {
      departmentId: dto.departmentId ?? employee.departmentId,
      reportingManagerId: dto.managerId ?? employee.reportingManagerId,
      locationId: dto.locationId ?? employee.locationId,
      designationId: dto.designationId ?? employee.designationId,
    };

    const updated = await this.databaseService.withTenant(
      tenantId,
      async (db) => {
        // Record history
        await db.insert(employmentHistory).values({
          tenant_id: tenantId,
          employee_id: employeeId,
          change_type: 'transfer',
          effective_from:
            dto.effectiveDate ?? new Date().toISOString().split('T')[0],
          previous_value: previousValue,
          new_value: newValue,
          reason: dto.reason,
          changed_by: adminId,
        });

        // Update employee record
        const [updated] = await db
          .update(employees)
          .set({
            department_id: dto.departmentId ?? employee.departmentId,
            reporting_manager_id: dto.managerId ?? employee.reportingManagerId,
            location_id: dto.locationId ?? employee.locationId,
            designation_id: dto.designationId ?? employee.designationId,
            updated_at: new Date(),
          })
          .where(eq(employees.id, employeeId))
          .returning();

        return updated;
      },
    );

    await this.auditService.log({
      tenantId,
      actorUserId: adminId,
      action: 'employee.transferred',
      resourceType: 'employee',
      resourceId: employeeId,
      beforeState: previousValue,
      afterState: newValue,
    });

    return updated;
  }

  /**
   * How much of a working record this person has. Drives the delete rule:
   * nothing here means the row was a mistake and can really go; anything here
   * means a hard DELETE would take statutory data with it, because FOURTEEN
   * tables CASCADE off employees.id (see migration 0057).
   *
   * Deliberately counts only the tables an Indian employer has to be able to
   * produce later — attendance, punches, leave, timesheets, documents, the
   * employment history and (Round P R4) the equipment register: anyone who
   * was ever issued a laptop / phone / ID card has an assignment row, open or
   * returned, and that trail must survive their removal. Emergency contacts
   * and an unopened invitation are not "history": a mistyped row usually has
   * both, and neither is worth keeping a ghost employee in the directory for.
   */
  private async historyFootprint(db: Db, tenantId: string, employeeId: string) {
    const count = async (table: typeof attendanceRecords | typeof attendancePunches
      | typeof leaveRequests | typeof timesheetEntries | typeof employeeDocuments) => {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(table)
        .where(
          and(
            eq(table.tenant_id, tenantId),
            eq(table.employee_id, employeeId),
          ),
        );
      return row?.n ?? 0;
    };
    const [attendance, punches, leave, timesheets, documents, assets] = await Promise.all([
      count(attendanceRecords),
      count(attendancePunches),
      count(leaveRequests),
      count(timesheetEntries),
      count(employeeDocuments),
      countAllAssignmentsTx(db, tenantId, employeeId),
    ]);
    // The hire row every employee gets at creation is not history; a SECOND
    // entry means something real happened (promotion, transfer, separation).
    const [hist] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(employmentHistory)
      .where(
        and(
          eq(employmentHistory.tenant_id, tenantId),
          eq(employmentHistory.employee_id, employeeId),
        ),
      );
    const historyRows = Math.max(0, (hist?.n ?? 0) - 1);
    const total = attendance + punches + leave + timesheets + documents + historyRows + assets;
    return { attendance, punches, leave, timesheets, documents, historyRows, assets, total };
  }

  /**
   * Round P R4: equipment the person still holds. Removal refuses while any
   * is open (the register would otherwise show a laptop in the hands of a
   * ghost), and the preview lists it so the dialog can warn before the click.
   */
  private async openAssetsHeld(db: Db, tenantId: string, employeeId: string) {
    const open = await listOpenAssignmentsTx(db, tenantId, employeeId);
    return open.map((a) => ({ asset_tag: a.asset_tag, name: a.name }));
  }

  /** The 409 the removal path throws while equipment is still out. */
  private assetsStillHeld(name: string, open: Array<{ asset_tag: string }>): ConflictException {
    const n = open.length;
    const tags = open.map((a) => a.asset_tag);
    const shown = tags.slice(0, 5).join(', ') + (tags.length > 5 ? ', …' : '');
    return new ConflictException({
      code: 'ASSETS_ASSIGNED',
      message: `${name} still holds ${n} asset${n === 1 ? '' : 's'} (${shown}) — record their return in People → Assets first.`,
    });
  }

  /**
   * What `DELETE /employees/:id` will do, without doing it — so the confirm
   * dialog can tell the truth ("this will be deleted" vs "this will be
   * removed but their records are kept") instead of guessing.
   */
  async previewRemoval(employeeId: string, tenantId: string) {
    return this.databaseService.withTenant(tenantId, async (db) => {
      const [emp] = await db
        .select({ id: employees.id, first: employees.first_name, last: employees.last_name })
        .from(employees)
        .where(and(eq(employees.id, employeeId), eq(employees.tenant_id, tenantId)))
        .limit(1);
      if (!emp) throw new NotFoundException('Employee not found');
      const [footprint, openAssets] = await Promise.all([
        this.historyFootprint(db, tenantId, employeeId),
        this.openAssetsHeld(db, tenantId, employeeId),
      ]);
      return {
        data: {
          mode: footprint.total === 0 ? ('delete' as const) : ('archive' as const),
          name: `${emp.first} ${emp.last}`.trim(),
          ...footprint,
          // Round P R4: what they still hold — removal will 409 until these
          // are returned, so the dialog says so up front.
          openAssets,
        },
      };
    });
  }

  /**
   * Remove an employee (founder round 21).
   *
   * The founder asked to be able to delete ANY employee. That is honoured, but
   * not by handing a DELETE to the database: 14 tables cascade off
   * employees.id, so a real delete of anyone who has worked here destroys their
   * attendance, punches, leave, timesheets and employment history — the PF/ESI
   * and wage-register substrate. So:
   *
   *   no history  -> a genuine DELETE (added by mistake; nothing to lose)
   *   any history -> deleted_at stamped; gone from every directory read, and
   *                  the statutory rows survive. Restorable.
   *
   * Either way the workspace membership is revoked, because "removed" that
   * leaves someone able to sign in is not removed. Offboarding (`terminate`)
   * did not do this either — a separated employee kept their login — so the
   * revoke lives here where both paths can reach it.
   */
  async removeEmployee(employeeId: string, tenantId: string, actorId: string) {
    const result = await this.databaseService.withTenant(
      tenantId,
      async (db) => {
        // FOR UPDATE: removal is check-then-write (open-asset guard, footprint,
        // then DELETE / deleted_at) at READ COMMITTED. Holding the row for the
        // whole tx serialises it against a concurrent assets assign — that
        // INSERT takes FOR KEY SHARE on this row for its employee_id FK, which
        // conflicts with FOR UPDATE — so a laptop can't be issued to someone
        // in the ms between the guard and the cascade that would eat the
        // assignment row and leave an 'assigned' asset with no holder.
        const [emp] = await db
          .select()
          .from(employees)
          .where(and(eq(employees.id, employeeId), eq(employees.tenant_id, tenantId)))
          .limit(1)
          .for('update');
        if (!emp) throw new NotFoundException('Employee not found');
        if (emp.deleted_at) {
          throw new BadRequestException('This employee has already been removed.');
        }
        // Never let an admin remove their own record and lock themselves out
        // mid-request.
        if (emp.user_id && emp.user_id === actorId) {
          throw new BadRequestException('You cannot remove your own employee record.');
        }

        // Role rules, mirroring the owner-only approval rule from round 18:
        // an admin may remove ordinary staff, but removing an OWNER or ADMIN
        // seat is the owner's call. Derived from the membership inside the
        // transaction, never from the client.
        const [targetSeat] = await db
          .select({ role: memberships.role, id: memberships.id })
          .from(memberships)
          .where(
            and(
              eq(memberships.tenant_id, tenantId),
              eq(memberships.employee_id, employeeId),
            ),
          )
          .limit(1);
        // Round Q: the shared seat rules (core/auth/seat-guards) — the self
        // case keeps its own message above.
        assertMayActOnSeat({
          actorRole: await actorSeatRoleTx(db, tenantId, actorId),
          targetRole: targetSeat?.role,
          isSelf: false,
          verb: 'remove',
        });
        // Never strand a workspace with nobody who can administer it.
        if (targetSeat) await assertNotLastOwnerTx(db, tenantId, targetSeat);

        const name = `${emp.first_name} ${emp.last_name}`.trim();

        // Round P R4: company equipment must come back before the person goes.
        // Removing them with a laptop still out would leave the register
        // pointing at a ghost, so the return is recorded first (People →
        // Assets). Checked inside the tx, before anything is written. One
        // query: the count, the tags in the message and the 409 itself all
        // come from the same rows (a second statement could see a return
        // committed in between and name nothing).
        const stillHeld = await this.openAssetsHeld(db, tenantId, employeeId);
        if (stillHeld.length > 0) throw this.assetsStillHeld(name, stillHeld);

        const footprint = await this.historyFootprint(db, tenantId, employeeId);

        // Revoke the seat either way — a removed person must not keep a login.
        // 'deactivated' is the membership enum's revoked state; the /me guard
        // and the (app) layout's revoked-tenant recovery both key off it.
        if (targetSeat) {
          await db
            .update(memberships)
            .set({ status: 'deactivated', employee_id: null })
            .where(eq(memberships.id, targetSeat.id));
        }

        if (footprint.total === 0) {
          // Nothing behind them: the cascade fires on empty tables.
          await db
            .delete(employees)
            .where(and(eq(employees.id, employeeId), eq(employees.tenant_id, tenantId)));
          return { mode: 'delete' as const, name, footprint, userId: emp.user_id };
        }

        await db
          .update(employees)
          .set({ deleted_at: new Date(), updated_at: new Date() })
          .where(and(eq(employees.id, employeeId), eq(employees.tenant_id, tenantId)));
        return { mode: 'archive' as const, name, footprint, userId: emp.user_id };
      },
      actorId,
    );
    // Round R: a removed person is signed out of this company at once (seat
    // deactivated above; sessions + sockets here) — not at token expiry.
    if (result.userId) await this.revokeTenantSessions(result.userId, tenantId);

    await this.auditService.log({
      tenantId,
      actorUserId: actorId,
      action: result.mode === 'delete' ? 'employee.deleted' : 'employee.archived',
      resourceType: 'employee',
      resourceId: employeeId,
      // A hard delete leaves nothing to count afterwards, so the log records
      // what was there at the time.
      metadata: { name: result.name, ...result.footprint },
    });
    this.eventEmitter.emit('employees.directory.changed', { tenantId });

    return {
      data: {
        id: employeeId,
        mode: result.mode,
        name: result.name,
        kept: result.footprint.total,
      },
    };
  }

  /**
   * Undo an archive. A hard-deleted employee has nothing to restore.
   *
   * Round P (R1.2): removal also revoked + unlinked the seat, and a restore
   * that brings the record back without the login was a dead end (Members →
   * Reactivate left employee_id null; login only activates `invited` seats).
   * So the seat is relinked here: a deactivated seat becomes `active` when
   * the person had accepted before, `invited` otherwise; a missing seat is
   * inserted as `invited`. Someone who never accepted still needs Resend
   * invite — the web toast says so.
   */
  async restoreEmployee(employeeId: string, tenantId: string, actorId: string) {
    const { row, seat, seatHeldBy } = await this.databaseService.withTenant(
      tenantId,
      async (db) => {
        const [emp] = await db
          .select()
          .from(employees)
          .where(and(eq(employees.id, employeeId), eq(employees.tenant_id, tenantId)))
          .limit(1);
        if (!emp) throw new NotFoundException('Employee not found');
        if (!emp.deleted_at) {
          return { row: emp, seat: 'unchanged' as const, seatHeldBy: null as string | null };
        }
        const [updated] = await db
          .update(employees)
          .set({ deleted_at: null, updated_at: new Date() })
          .where(and(eq(employees.id, employeeId), eq(employees.tenant_id, tenantId)))
          .returning();

        let seat: 'unchanged' | 'active' | 'invited' = 'unchanged';
        let seatHeldBy: string | null = null;
        if (emp.user_id) {
          const [m] = await db
            .select()
            .from(memberships)
            .where(
              and(eq(memberships.tenant_id, tenantId), eq(memberships.user_id, emp.user_id)),
            )
            .orderBy(asc(memberships.created_at))
            .limit(1);
          if (!m) {
            await db.insert(memberships).values({
              tenant_id: tenantId,
              user_id: emp.user_id,
              employee_id: employeeId,
              role: 'employee',
              status: 'invited',
              invited_by: actorId,
              invited_at: new Date(),
            });
            seat = 'invited';
          } else if (await this.seatHeldByAnotherLiveRow(db, tenantId, m, employeeId)) {
            // The person was re-added under another work email meanwhile:
            // that live record keeps the seat, this one comes back without.
            seatHeldBy = m.employee_id;
          } else if (m.status === 'deactivated') {
            const status = m.accepted_at ? 'active' : 'invited';
            await db
              .update(memberships)
              .set({ status, employee_id: employeeId })
              .where(and(eq(memberships.id, m.id), eq(memberships.tenant_id, tenantId)));
            seat = status;
          } else if (m.employee_id !== employeeId) {
            await db
              .update(memberships)
              .set({ employee_id: employeeId })
              .where(and(eq(memberships.id, m.id), eq(memberships.tenant_id, tenantId)));
            seat = m.status === 'active' ? 'active' : 'invited';
          }
        }
        return { row: updated!, seat, seatHeldBy };
      },
      actorId,
    );
    await this.auditService.log({
      tenantId,
      actorUserId: actorId,
      action: 'employee.restored',
      resourceType: 'employee',
      resourceId: employeeId,
      metadata: {
        name: `${row.first_name} ${row.last_name}`.trim(),
        seat,
        ...(seatHeldBy ? { seatHeldByEmployeeId: seatHeldBy } : {}),
      },
    });
    this.eventEmitter.emit('employees.directory.changed', { tenantId });
    return { data: { id: employeeId, restored: true, seat } };
  }

  /** The workspace seat linked to an employee row (null when none). */
  private async seatForEmployeeTx(db: Db, tenantId: string, employeeId: string, userId?: string | null) {
    const cols = {
      id: memberships.id,
      role: memberships.role,
      status: memberships.status,
      accepted_at: memberships.accepted_at,
      employee_id: memberships.employee_id,
    };
    const [linked] = await db
      .select(cols)
      .from(memberships)
      .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.employee_id, employeeId)))
      .limit(1);
    if (linked || !userId) return linked ?? null;
    // A seat unlinked by an earlier removal still belongs to the same person.
    const [byUser] = await db
      .select(cols)
      .from(memberships)
      .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.user_id, userId)))
      .orderBy(asc(memberships.created_at))
      .limit(1);
    return byUser ?? null;
  }

  /**
   * Sign the person out of THIS company: revoke the refresh tokens minted
   * for it (their other companies keep working). The seat is already
   * deactivated in the same request, so the live-seat RolesGuard refuses
   * them on the next click even before the access token expires — this
   * closes the 30-day refresh path too. Best-effort after commit.
   */
  private async revokeTenantSessions(userId: string, tenantId: string): Promise<void> {
    // Round R: every open socket of this person in this company drops too.
    this.eventEmitter.emit('seat.revoked', { tenantId, userId });
    try {
      await this.dbAdmin
        .update(refreshTokens)
        .set({ revoked_at: new Date() })
        .where(
          and(
            eq(refreshTokens.user_id, userId),
            eq(refreshTokens.tenant_id, tenantId),
            isNull(refreshTokens.revoked_at),
          ),
        );
    } catch (err) {
      this.logger.warn(
        `session revoke for user ${userId} in tenant ${tenantId} failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Off-board an employee (Round Q — founder 2026-10-06: "if a user is
   * off-boarded it should automatically get off-boarded and deactivate the
   * user … a checkbox: if ticked, off-boarded immediately, without notice;
   * if not, the notice period starts").
   *
   *  immediate → status `separated`, date_of_exit today, seat deactivated and
   *              this company's sessions revoked — signed out on the next click.
   *  notice    → status `notice_period`, date_of_exit = the last working day
   *              (default today + their notice period). They keep working;
   *              SeparationJob finishes the off-boarding after that day.
   *
   * Calling it again with `immediate` on someone serving notice is "End
   * notice now". Deleting stays a separate, later step (Remove). The seat
   * rules (core/auth/seat-guards) apply: not yourself, Owner / HR-admin seats
   * are the Owner's call, never the last Owner.
   */
  async terminateEmployee(
    employeeId: string,
    dto: TerminateEmployeeDto,
    adminId: string,
    tenantId: string,
  ) {
    const immediate = dto.immediate === true;
    const result = await this.databaseService.withTenant(
      tenantId,
      async (db) => {
        const [emp] = await db
          .select()
          .from(employees)
          .where(and(eq(employees.id, employeeId), eq(employees.tenant_id, tenantId)))
          .limit(1)
          .for('update');
        if (!emp) throw new NotFoundException('Employee not found');
        const name = `${emp.first_name} ${emp.last_name}`.trim();
        if (emp.deleted_at) {
          throw new ConflictException({
            code: 'EMPLOYEE_REMOVED',
            message: `${name} has been removed — restore them from People → Removed first.`,
          });
        }
        if (emp.status === 'separated' || emp.status === 'absconded') {
          throw new ConflictException({
            code: 'ALREADY_OFFBOARDED',
            message: `${name} has already been off-boarded.`,
          });
        }
        if (emp.status === 'inactive') {
          throw new ConflictException({
            code: 'NOT_JOINED',
            message: `${name} hasn't joined yet — use Remove instead of off-boarding.`,
          });
        }
        if (!immediate && emp.status === 'notice_period') {
          throw new ConflictException({
            code: 'ALREADY_ON_NOTICE',
            message: `${name} is already serving notice${emp.date_of_exit ? ` (last working day ${emp.date_of_exit})` : ''}. Use “End notice now” to off-board them immediately.`,
          });
        }

        const seat = await this.seatForEmployeeTx(db, tenantId, employeeId);
        assertMayActOnSeat({
          actorRole: await actorSeatRoleTx(db, tenantId, adminId),
          targetRole: seat?.role,
          isSelf: !!emp.user_id && emp.user_id === adminId,
          verb: 'off-board',
        });
        // An Owner on notice is deactivated when it ends — refuse up front.
        if (seat) await assertNotLastOwnerTx(db, tenantId, seat);

        const today = await tenantTodayISOTx(db, tenantId);
        let lastWorkingDate = today;
        if (!immediate) {
          lastWorkingDate = dto.lastWorkingDate ?? addDaysISO(today, emp.notice_period_days ?? 30);
          if (lastWorkingDate < today) {
            throw new BadRequestException(
              'The last working day is in the past — tick “Off-board immediately” instead.',
            );
          }
        }
        const newStatus = immediate ? ('separated' as const) : ('notice_period' as const);

        await db
          .update(employees)
          .set({
            status: newStatus,
            date_of_exit: lastWorkingDate,
            exit_reason: dto.reason,
            updated_at: new Date(),
          })
          .where(and(eq(employees.id, employeeId), eq(employees.tenant_id, tenantId)));

        await db.insert(employmentHistory).values({
          tenant_id: tenantId,
          employee_id: employeeId,
          change_type: 'separation',
          effective_from: lastWorkingDate,
          previous_value: {
            designationId: emp.designation_id,
            status: emp.status,
            dateOfExit: emp.date_of_exit,
          },
          new_value: { status: newStatus, separationType: dto.separationType ?? null, immediate },
          reason: dto.reason,
          changed_by: adminId,
        });

        if (immediate && seat && seat.status !== 'deactivated') {
          await db
            .update(memberships)
            .set({ status: 'deactivated' })
            .where(and(eq(memberships.id, seat.id), eq(memberships.tenant_id, tenantId)));
        }
        return { name, previousStatus: emp.status, lastWorkingDate, newStatus, userId: emp.user_id };
      },
      adminId,
    );

    if (immediate && result.userId) await this.revokeTenantSessions(result.userId, tenantId);

    await this.auditService.log({
      tenantId,
      actorUserId: adminId,
      action: immediate ? 'employee.separated' : 'employee.termination.initiated',
      resourceType: 'employee',
      resourceId: employeeId,
      metadata: {
        name: result.name,
        reason: dto.reason,
        lastWorkingDate: result.lastWorkingDate,
        separationType: dto.separationType ?? null,
        immediate,
        previousStatus: result.previousStatus,
      },
    });
    this.eventEmitter.emit('employees.directory.changed', { tenantId });

    return {
      employeeId,
      status: result.newStatus,
      lastWorkingDate: result.lastWorkingDate,
      immediate,
      reason: dto.reason,
    };
  }

  /**
   * Undo an off-boarding (Round Q — "never leave a dead end"): someone
   * serving notice, or already separated by mistake, goes back to active and
   * gets their seat back. Same seat rules as off-boarding.
   */
  async cancelOffboarding(employeeId: string, adminId: string, tenantId: string) {
    const result = await this.databaseService.withTenant(
      tenantId,
      async (db) => {
        const [emp] = await db
          .select()
          .from(employees)
          .where(and(eq(employees.id, employeeId), eq(employees.tenant_id, tenantId)))
          .limit(1)
          .for('update');
        if (!emp) throw new NotFoundException('Employee not found');
        const name = `${emp.first_name} ${emp.last_name}`.trim();
        if (emp.deleted_at) {
          throw new ConflictException({
            code: 'EMPLOYEE_REMOVED',
            message: `${name} has been removed — restore them from People → Removed first.`,
          });
        }
        if (emp.status !== 'notice_period' && emp.status !== 'separated') {
          throw new ConflictException({
            code: 'NOT_OFFBOARDING',
            message: `${name} isn't being off-boarded.`,
          });
        }
        const wasSeparated = emp.status === 'separated';
        const seat = await this.seatForEmployeeTx(db, tenantId, employeeId, emp.user_id);
        assertMayActOnSeat({
          actorRole: await actorSeatRoleTx(db, tenantId, adminId),
          targetRole: seat?.role,
          isSelf: !!emp.user_id && emp.user_id === adminId,
          verb: wasSeparated ? 'reinstate' : 'cancel the off-boarding of',
        });

        const today = await tenantTodayISOTx(db, tenantId);
        await db
          .update(employees)
          .set({ status: 'active', date_of_exit: null, exit_reason: null, updated_at: new Date() })
          .where(and(eq(employees.id, employeeId), eq(employees.tenant_id, tenantId)));
        await db.insert(employmentHistory).values({
          tenant_id: tenantId,
          employee_id: employeeId,
          change_type: wasSeparated ? 'rehire' : 'status_change',
          effective_from: today,
          previous_value: { status: emp.status, dateOfExit: emp.date_of_exit },
          new_value: { status: 'active' },
          reason: wasSeparated ? 'Reinstated after off-boarding' : 'Off-boarding cancelled',
          changed_by: adminId,
        });

        let seatStatus: string | null = seat?.status ?? null;
        if (seat && (seat.status === 'deactivated' || seat.employee_id !== employeeId)) {
          seatStatus = seat.status === 'deactivated' ? (seat.accepted_at ? 'active' : 'invited') : seat.status;
          await db
            .update(memberships)
            .set({ status: seatStatus as 'active' | 'invited', employee_id: employeeId })
            .where(and(eq(memberships.id, seat.id), eq(memberships.tenant_id, tenantId)));
        }
        return { name, previousStatus: emp.status, seatStatus };
      },
      adminId,
    );

    await this.auditService.log({
      tenantId,
      actorUserId: adminId,
      action: 'employee.offboarding.cancelled',
      resourceType: 'employee',
      resourceId: employeeId,
      metadata: { name: result.name, previousStatus: result.previousStatus, seat: result.seatStatus },
    });
    this.eventEmitter.emit('employees.directory.changed', { tenantId });
    return { data: { id: employeeId, status: 'active', seat: result.seatStatus } };
  }

  /**
   * SeparationJob (hourly): finish every notice period whose last working day
   * has passed in the company's own timezone — status `separated`, seat
   * deactivated, this company's sessions revoked, Owners / HR told in-app.
   * People put on notice before Round Q have no date_of_exit; their
   * separation history row's date is used instead (null → left alone; HR can
   * still use "End notice now"). Per-row tenant transactions with a re-check
   * under FOR UPDATE, so a concurrent cancel always wins cleanly.
   */
  async completeDueSeparations(now: Date = new Date()) {
    const out = { scanned: 0, separated: 0, failed: 0 };
    // A cron has no tenant: the scan runs on dbAdmin and only yields ids; every
    // decision and write below happens under withTenant(row.tenant_id).
    const candidates = await this.dbAdmin
      .select({ id: employees.id, tenantId: employees.tenant_id })
      .from(employees)
      .where(and(eq(employees.status, 'notice_period'), isNull(employees.deleted_at)))
      .orderBy(asc(employees.tenant_id))
      .limit(1000);
    out.scanned = candidates.length;

    for (const c of candidates) {
      try {
        const done = await this.databaseService.withTenant(c.tenantId, async (db) => {
          const [emp] = await db
            .select()
            .from(employees)
            .where(and(eq(employees.id, c.id), eq(employees.tenant_id, c.tenantId)))
            .limit(1)
            .for('update');
          if (!emp || emp.deleted_at || emp.status !== 'notice_period') return null;
          let lastDay = emp.date_of_exit;
          if (!lastDay) {
            const [h] = await db
              .select({ d: employmentHistory.effective_from })
              .from(employmentHistory)
              .where(
                and(
                  eq(employmentHistory.tenant_id, c.tenantId),
                  eq(employmentHistory.employee_id, c.id),
                  eq(employmentHistory.change_type, 'separation'),
                ),
              )
              .orderBy(desc(employmentHistory.created_at))
              .limit(1);
            lastDay = h?.d ?? null;
          }
          if (!lastDay) return null;
          const today = await tenantTodayISOTx(db, c.tenantId, now);
          if (!(lastDay < today)) return null;

          await db
            .update(employees)
            .set({ status: 'separated', date_of_exit: lastDay, updated_at: new Date() })
            .where(and(eq(employees.id, c.id), eq(employees.tenant_id, c.tenantId)));
          const seat = await this.seatForEmployeeTx(db, c.tenantId, c.id);
          if (seat && seat.status !== 'deactivated') {
            await db
              .update(memberships)
              .set({ status: 'deactivated' })
              .where(and(eq(memberships.id, seat.id), eq(memberships.tenant_id, c.tenantId)));
          }
          const admins = await db
            .select({ userId: memberships.user_id })
            .from(memberships)
            .where(
              and(
                eq(memberships.tenant_id, c.tenantId),
                eq(memberships.status, 'active'),
                inArray(memberships.role, ['owner', 'admin']),
              ),
            );
          return {
            name: `${emp.first_name} ${emp.last_name}`.trim(),
            userId: emp.user_id,
            lastDay,
            notify: admins.map((a) => a.userId).filter((u): u is string => !!u && u !== emp.user_id),
          };
        });
        if (!done) continue;
        out.separated++;
        if (done.userId) await this.revokeTenantSessions(done.userId, c.tenantId);
        await this.auditService.log({
          tenantId: c.tenantId,
          action: 'employee.separated',
          resourceType: 'employee',
          resourceId: c.id,
          metadata: { name: done.name, lastWorkingDate: done.lastDay, by: 'notice_period_end' },
        });
        for (const uid of done.notify) {
          void this.notificationsService.createInAppNotification(
            uid,
            'employee.separated',
            `${done.name}'s notice period ended — they're off-boarded and their sign-in is turned off.`,
            `/employees/${c.id}`,
            c.tenantId,
          );
        }
        this.eventEmitter.emit('employees.directory.changed', { tenantId: c.tenantId });
      } catch (err) {
        out.failed++;
        this.logger.warn(
          `separation: employee ${c.id} (tenant ${c.tenantId}) failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return out;
  }

  /**
   * Round Q — onboarding approvals waiting more than 24 hours (founder: "if
   * the HR manager is not approving it for 24 hours, it should go to the
   * higher reporting manager of the HR manager"). Decision 2026-10-06: the
   * reporting manager of each active HR admin, when that person can already
   * approve onboarding (an active Owner or HR admin); otherwise the Owners.
   * No new permissions — the joiner's PAN / bank / address stay with HR and
   * Owners. An HR admin's own onboarding is the Owners' call (round 18), so
   * it escalates straight to them. One escalation per submission (a send-back
   * and resubmission clears the marker); the onboarding cron calls this every
   * 15 minutes.
   */
  async escalateStaleOnboarding(now: Date = new Date()) {
    const out = { scanned: 0, escalated: 0, failed: 0 };
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    // Cron scan on dbAdmin: ids only; every decision and write happens under
    // withTenant(row.tenant_id). The regex guard keeps a malformed timestamp
    // from failing the whole scan.
    const submittedAt = sql`CASE WHEN ${employees.custom_fields}->>'onboarding_submitted_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN (${employees.custom_fields}->>'onboarding_submitted_at')::timestamptz END`;
    const candidates = await this.dbAdmin
      .select({ id: employees.id, tenantId: employees.tenant_id })
      .from(employees)
      .where(
        and(
          eq(employees.status, 'inactive'),
          isNull(employees.deleted_at),
          sql`(${employees.custom_fields}->>'onboarding_submitted_for_review')::boolean = true`,
          sql`${employees.custom_fields}->>'onboarding_escalated_at' IS NULL`,
          sql`${submittedAt} < ${cutoff.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(asc(employees.tenant_id))
      .limit(500);
    out.scanned = candidates.length;

    for (const c of candidates) {
      try {
        const done = await this.databaseService.withTenant(c.tenantId, async (db) => {
          const [emp] = await db
            .select()
            .from(employees)
            .where(and(eq(employees.id, c.id), eq(employees.tenant_id, c.tenantId)))
            .limit(1)
            .for('update');
          if (!emp || emp.deleted_at || emp.status !== 'inactive') return null;
          const cf = (emp.custom_fields ?? {}) as Record<string, unknown>;
          const flag = cf.onboarding_submitted_for_review;
          if ((flag !== true && flag !== 'true') || cf.onboarding_escalated_at) return null;
          const sub = typeof cf.onboarding_submitted_at === 'string' ? Date.parse(cf.onboarding_submitted_at) : NaN;
          if (!Number.isFinite(sub) || sub >= cutoff.getTime()) return null;

          const targets = await this.onboardingEscalationTargetsTx(db, c.tenantId, emp);
          await db
            .update(employees)
            .set({
              custom_fields: {
                ...cf,
                onboarding_escalated_at: now.toISOString(),
                onboarding_escalated_to: targets.people.map((t) => t.userId),
              },
              updated_at: new Date(),
            })
            .where(and(eq(employees.id, c.id), eq(employees.tenant_id, c.tenantId)));
          return {
            name: `${emp.first_name} ${emp.last_name}`.trim() || 'A new joiner',
            submittedAt: new Date(sub),
            ...targets,
          };
        });
        if (!done) continue;
        out.escalated++;
        await this.auditService.log({
          tenantId: c.tenantId,
          action: 'employee.onboarding.escalated',
          resourceType: 'employee',
          resourceId: c.id,
          metadata: {
            name: done.name,
            to: done.people.map((p) => p.userId),
            via: done.via,
          },
        });
        const appUrl = this.configService.get<string>('APP_URL', 'http://localhost:3000').replace(/\/$/, '');
        const submitted = done.submittedAt.toLocaleDateString('en-IN', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          timeZone: 'Asia/Kolkata',
        });
        for (const t of done.people) {
          await this.notificationsService
            .createInAppNotification(
              t.userId,
              'onboarding.escalated',
              `${done.name}'s onboarding has waited over 24 hours for approval — please review it.`,
              '/employees/onboarding',
              c.tenantId,
              { groupKey: `onboarding:${c.id}` },
            )
            .catch(() => undefined);
          if (!t.email) continue;
          await this.notificationsService
            .sendEmail('approval-escalated', t.email, {
              reviewerName: t.name || 'there',
              employeeName: done.name,
              kindLabel: 'onboarding',
              summary: `Self-onboarding submitted on ${submitted}`,
              reasonText: 'no action for 24 hours',
              levelLabel: done.via === 'hr_manager' ? "as the HR admin's reporting manager" : 'as an Owner',
              reviewUrl: `${appUrl}/employees/onboarding`,
              stillActs: 'HR can still approve it too.',
            })
            .catch(() => undefined);
        }
      } catch (err) {
        out.failed++;
        this.logger.warn(
          `onboarding-escalation: employee ${c.id} (tenant ${c.tenantId}) failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return out;
  }

  /**
   * Who a stale onboarding escalates to (see escalateStaleOnboarding). Only
   * people who may already approve onboarding — an active Owner or HR admin
   * seat — and never the joiner. `via` says which rule applied.
   */
  private async onboardingEscalationTargetsTx(
    db: Db,
    tenantId: string,
    joiner: { id: string; user_id: string | null },
  ): Promise<{ via: 'hr_manager' | 'owners'; people: Array<{ userId: string; email: string | null; name: string }> }> {
    const seatCols = {
      userId: memberships.user_id,
      role: memberships.role,
      employeeId: memberships.employee_id,
      email: users.email,
      name: users.full_name,
    };
    const active = await db
      .select(seatCols)
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.user_id))
      .where(
        and(
          eq(memberships.tenant_id, tenantId),
          eq(memberships.status, 'active'),
          inArray(memberships.role, ['owner', 'admin']),
          eq(users.status, 'active'),
        ),
      );
    const notJoiner = (p: { userId: string | null; employeeId: string | null }) =>
      !!p.userId && p.userId !== joiner.user_id && p.employeeId !== joiner.id;
    const owners = active.filter((p) => p.role === 'owner' && notJoiner(p));
    const toPeople = (rows: typeof active) =>
      [...new Map(rows.map((r) => [r.userId!, { userId: r.userId!, email: r.email ?? null, name: r.name ?? '' }])).values()];

    // The joiner's own seat: an HR admin's (or Owner's) file is the Owners'.
    const [joinerSeat] = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.employee_id, joiner.id)))
      .limit(1);
    if (joinerSeat && isSeniorSeatRole(joinerSeat.role)) {
      return { via: 'owners', people: toPeople(owners) };
    }

    // Each HR admin's reporting manager, kept only when that person holds an
    // active Owner / HR-admin seat (they can approve onboarding already).
    const hrAdmins = active.filter((p) => p.role === 'admin' && notJoiner(p));
    const managerIds = new Set<string>();
    for (const hr of hrAdmins) {
      let hrEmployeeId = hr.employeeId;
      if (!hrEmployeeId) {
        const [e] = await db
          .select({ id: employees.id })
          .from(employees)
          .where(and(eq(employees.tenant_id, tenantId), eq(employees.user_id, hr.userId!), isNull(employees.deleted_at)))
          .limit(1);
        hrEmployeeId = e?.id ?? null;
      }
      if (!hrEmployeeId) continue;
      const [row] = await db
        .select({ managerId: employees.reporting_manager_id })
        .from(employees)
        .where(and(eq(employees.tenant_id, tenantId), eq(employees.id, hrEmployeeId)))
        .limit(1);
      if (row?.managerId) managerIds.add(row.managerId);
    }
    const managers: typeof active = [];
    for (const managerId of managerIds) {
      const [m] = await db
        .select({ id: employees.id, userId: employees.user_id, deletedAt: employees.deleted_at, status: employees.status })
        .from(employees)
        .where(and(eq(employees.tenant_id, tenantId), eq(employees.id, managerId)))
        .limit(1);
      if (!m || m.deletedAt || !['active', 'on_leave', 'notice_period'].includes(m.status)) continue;
      const seat = active.find((p) => p.employeeId === m.id || (!!m.userId && p.userId === m.userId));
      if (seat && notJoiner(seat)) managers.push(seat);
    }
    if (managers.length > 0) return { via: 'hr_manager', people: toPeople(managers) };
    return { via: 'owners', people: toPeople(owners) };
  }

  async getEmploymentHistory(employeeId: string, tenantId: string) {
    await this.getEmployee(employeeId, tenantId); // verify access

    return this.databaseService.withTenant(tenantId, (db) =>
      db
        .select()
        .from(employmentHistory)
        .where(eq(employmentHistory.employee_id, employeeId))
        .orderBy(desc(employmentHistory.effective_from)),
    );
  }

  async getOrgChart(tenantId: string) {
    const allEmployees = await this.databaseService.withTenant(tenantId, (db) =>
      db
        .select({
          id: employees.id,
          employeeCode: employees.employee_code,
          fullName: users.full_name,
          email: users.email,
          avatarUrl: users.avatar_url,
          avatarKey: users.avatar_key,
          userId: employees.user_id, // D9 presence keying
          designationTitle: designations.title,
          departmentName: departments.name,
          managerId: employees.reporting_manager_id,
          status: employees.status,
        })
        .from(employees)
        .leftJoin(users, eq(employees.user_id, users.id))
        .leftJoin(designations, eq(employees.designation_id, designations.id))
        .leftJoin(departments, eq(employees.department_id, departments.id))
        .where(
          and(
            eq(employees.tenant_id, tenantId),
            isNull(employees.deleted_at),
            inArray(employees.status, ['active', 'on_leave', 'notice_period']),
          ),
        ),
    );

    // Resolve photos before the tree is assembled — the nodes are what the
    // chart renders, and they must carry a usable avatarUrl.
    const withPhotos = await this.withAvatars(allEmployees);

    type OrgNode = (typeof withPhotos)[number] & { children: OrgNode[] };

    const nodeMap = new Map<string, OrgNode>();
    for (const emp of withPhotos) {
      nodeMap.set(emp.id, { ...emp, children: [] });
    }

    const roots: OrgNode[] = [];
    for (const emp of withPhotos) {
      const node = nodeMap.get(emp.id)!;
      if (emp.managerId && nodeMap.has(emp.managerId)) {
        nodeMap.get(emp.managerId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return { tree: roots, total: allEmployees.length };
  }

  async generateSignedUrl(r2Key: string): Promise<{ url: string; expiresAt: Date }> {
    // Security audit 2026-10-06: this used to return `${R2_PUBLIC_URL}/<key>` —
    // a permanent, unsigned public link (and a made-up expiry). Employee
    // documents are private: sign a 15-minute GET, never hand out a public URL.
    if (!r2Key) throw new NotFoundException('Document file not found');
    if (!this.r2?.isConfigured()) {
      throw new ServiceUnavailableException('File storage is not configured on this server.');
    }
    const ttlSeconds = 15 * 60;
    return {
      url: await this.r2.signedGetUrl(r2Key, ttlSeconds),
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    };
  }

  async getDocumentSignedUrl(
    employeeId: string,
    docId: string,
    tenantId: string,
  ): Promise<{ url: string; expiresAt: Date }> {
    const doc = await this.databaseService.withTenant(tenantId, async (db) => {
      const [doc] = await db
        .select()
        .from(employeeDocuments)
        .where(
          and(
            eq(employeeDocuments.id, docId),
            eq(employeeDocuments.employee_id, employeeId),
            eq(employeeDocuments.tenant_id, tenantId),
          ),
        )
        .limit(1);
      return doc;
    });

    if (!doc) {
      throw new NotFoundException('Document not found');
    }

    return this.generateSignedUrl(doc.r2_key ?? '');
  }
}
