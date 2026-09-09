import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as crypto from 'crypto';
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import {
  calendarEventAttendees,
  calendarEvents,
  departments,
  employees,
  holidays,
  leaveRequests,
  leaveTypes,
  memberships,
  tenants,
  users,
} from '@flicks/db/schema';
import type { Db, DbAdmin } from '@flicks/db';
import type { JwtPayload, UserRole } from '@flicks/shared/types';
import {
  ATTENDEE_RESPONSES,
  MEETING_PROVIDERS,
  type AttendeeResponse,
  type MeetingProvider,
} from '@flicks/shared/constants';
import { DatabaseService } from '../../core/database/database.service';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import { DomainEventsService } from '../../core/events/domain-events.service';
import { ModuleAccessService } from '../../core/auth/module-access.service';
import {
  addDaysISO,
  dateInTimezone,
  formatRangeInTimezone,
  isValidTimezone,
} from '../../core/common/time';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MediaService } from '../media/media.service';
import { CrmPublicService } from '../crm/public';
import { MeetingLinksService } from './meeting-links.service';
import type {
  AttendeeInputDto,
  CreateCalendarEventDto,
  RsvpDto,
  UpdateCalendarEventDto,
} from './calendar.dto';

// ─── Public shapes ────────────────────────────────────────────────────────────

export type CalendarItemType =
  | 'holiday'
  | 'my_leave'
  | 'team_leave'
  | 'event'
  | 'meeting'
  | 'birthday'
  | 'anniversary'
  | 'crm_activity';

export interface CalendarPerson {
  userId: string;
  name: string;
  avatarUrl: string | null;
}

export interface CalendarAttendee extends CalendarPerson {
  response: AttendeeResponse;
  isOptional: boolean;
}

/**
 * One row of the unified feed. Read-only sources (holidays, leave, birthdays,
 * CRM) and user-authored events share the shape so the web renders them from
 * a single list. Instants are ISO-8601 UTC; `startDate`/`endDate` are the
 * inclusive calendar days the item occupies in its own `timezone`.
 */
export interface CalendarFeedItem {
  id: string;
  type: CalendarItemType;
  title: string;
  allDay: boolean;
  startAt: string;
  endAt: string;
  startDate: string;
  endDate: string;
  timezone: string;
  color: string | null;
  status?: string;
  description?: string | null;
  location?: string | null;
  meetingProvider?: MeetingProvider;
  meetingUrl?: string | null;
  visibility?: 'private' | 'team' | 'company';
  organizer?: CalendarPerson | null;
  attendees?: CalendarAttendee[];
  myResponse?: AttendeeResponse | null;
  canEdit: boolean;
  link?: string;
  meta?: Record<string, unknown>;
}

export interface CalendarPrefs {
  timezone: string;
  weekStartsOn: number;
  workingDays: number[];
  workStart: string;
  workEnd: string;
}

export interface CalendarFeed {
  data: CalendarFeedItem[];
  prefs: CalendarPrefs;
  sources: { crm: boolean };
}

export interface InvitablePerson extends CalendarPerson {
  email: string;
  departmentName: string | null;
}

/** Roles that see the whole workspace's availability (Round I constant). */
const ORG_WIDE_ROLES: ReadonlyArray<string> = ['owner', 'admin', 'fam', 'super_admin'];
/** Seats that never see the calendar (guests are also refused by GuestScopeGuard). */
const NO_SEAT_ROLES: ReadonlyArray<string> = ['guest', 'auditor'];
/** Employee states that still count as "in the team". */
const PRESENT_EMPLOYEE_STATUSES = ['active', 'notice_period', 'on_leave'] as const;
/** Roles allowed to open employee profiles from a birthday chip. */
const PROFILE_ROLES: ReadonlyArray<string> = ['owner', 'admin', 'manager', 'fam', 'super_admin'];

const MAX_RANGE_DAYS = 93;
const MAX_TIMED_DAYS = 14;
const MAX_ALLDAY_DAYS = 31;
const DEFAULT_TZ = 'Asia/Kolkata';

const COLORS = {
  holiday: '#FED800',
  myLeave: '#3E7BFA',
  teamLeave: '#9B7BFA',
  event: '#27D280',
  birthday: '#9B7BFA',
  anniversary: '#27D280',
  crm: '#5B9BFF',
} as const;

const PROVIDER_HOSTS: Record<Exclude<MeetingProvider, 'none' | 'other'>, string[]> = {
  teams: ['teams.microsoft.com', 'teams.live.com'],
  google_meet: ['meet.google.com'],
};

interface Viewer {
  userId: string;
  role: string;
  orgWide: boolean;
  employeeId: string | null;
  managerId: string | null;
  locationId: string | null;
  name: string;
  email: string;
  timezone: string;
}

interface EventRow {
  id: string;
  tenant_id: string;
  kind: string;
  title: string;
  description: string | null;
  location: string | null;
  start_at: Date;
  end_at: Date;
  is_all_day: boolean;
  timezone: string;
  visibility: 'private' | 'team' | 'company';
  color: string | null;
  meeting_provider: string;
  meeting_url: string | null;
  organizer_user_id: string | null;
  cancelled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface AttendeeRow {
  event_id: string;
  user_id: string;
  is_optional: boolean;
  response: string;
  name: string;
  email: string;
  avatar_key: string | null;
  avatar_url: string | null;
  timezone: string;
}

type NotifyKind = 'invited' | 'updated' | 'cancelled';

@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly domainEvents: DomainEventsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly media: MediaService,
    private readonly crm: CrmPublicService,
    private readonly moduleAccess: ModuleAccessService,
    private readonly meetingLinks: MeetingLinksService,
  ) {}

  // ─── Seat / scope helpers ──────────────────────────────────────────────────

  /** The JWT role the guards already trusted; platform staff act as an owner. */
  roleHint(user: Pick<JwtPayload, 'role' | 'isPlatformAdmin'>): string {
    return user.isPlatformAdmin ? 'owner' : (user.role ?? '');
  }

  /** Guests and auditors have no workspace calendar (403, never a partial feed). */
  assertWorkspaceSeat(role: string): void {
    if (NO_SEAT_ROLES.includes(role)) {
      throw new ForbiddenException('The calendar is not available for this seat');
    }
  }

  /**
   * Who is looking, resolved INSIDE the tenant transaction (no dbAdmin): the
   * active membership, its employee row (may be absent — an owner seat with
   * no HR record still gets holidays + events) and that employee's manager.
   */
  private async resolveViewer(tx: Db, tenantId: string, userId: string, roleHint: string): Promise<Viewer> {
    const [row] = await tx
      .select({
        role: memberships.role,
        employeeId: memberships.employee_id,
        name: users.full_name,
        email: users.email,
        timezone: users.timezone,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.user_id))
      .where(
        and(
          eq(memberships.tenant_id, tenantId),
          eq(memberships.user_id, userId),
          eq(memberships.status, 'active'),
        ),
      )
      .limit(1);
    if (!row) throw new ForbiddenException('No active membership in this workspace');

    const role = roleHint || row.role;
    let employeeId: string | null = null;
    let managerId: string | null = null;
    let locationId: string | null = null;
    if (row.employeeId) {
      const [emp] = await tx
        .select({
          id: employees.id,
          managerId: employees.reporting_manager_id,
          locationId: employees.location_id,
        })
        .from(employees)
        .where(
          and(
            eq(employees.tenant_id, tenantId),
            eq(employees.id, row.employeeId),
            isNull(employees.deleted_at),
          ),
        )
        .limit(1);
      if (emp) {
        employeeId = emp.id;
        managerId = emp.managerId ?? null;
        locationId = emp.locationId ?? null;
      }
    }
    return {
      userId,
      role,
      orgWide: ORG_WIDE_ROLES.includes(role),
      employeeId,
      managerId,
      locationId,
      name: row.name,
      email: row.email,
      timezone: isValidTimezone(row.timezone) ? row.timezone : DEFAULT_TZ,
    };
  }

  /**
   * Founder decision (Round J): everyone sees the availability of their
   * teammates (same manager) and their manager; managers also see their
   * reports; owner / HR admin see the whole workspace. Requires `employees`
   * to be joined. Members without an employee row see nobody.
   */
  private availabilityScope(viewer: Viewer): SQL {
    if (viewer.orgWide) return sql`true`;
    if (!viewer.employeeId) return sql`false`;
    const parts: SQL[] = [sql`${employees.reporting_manager_id} = ${viewer.employeeId}`];
    if (viewer.managerId) {
      parts.push(sql`${employees.reporting_manager_id} = ${viewer.managerId}`);
      parts.push(sql`${employees.id} = ${viewer.managerId}`);
    }
    return sql`(${sql.join(parts, sql` OR `)})`;
  }

  /** Which user-authored events the viewer may see. */
  private visibleEventPredicate(tenantId: string, viewer: Viewer): SQL {
    if (viewer.orgWide) return sql`true`;
    return sql`(
      ${calendarEvents.organizer_user_id} = ${viewer.userId}
      OR ${calendarEvents.visibility} = 'company'
      OR EXISTS (
        SELECT 1 FROM ${calendarEventAttendees} a
        WHERE a.event_id = ${calendarEvents.id}
          AND a.tenant_id = ${tenantId}
          AND a.user_id = ${viewer.userId}
      )
    )`;
  }

  private async loadPrefs(tx: Db, tenantId: string): Promise<CalendarPrefs & { name: string }> {
    const [t] = await tx
      .select({
        name: tenants.name,
        timezone: tenants.timezone,
        weekStartsOn: tenants.week_starts_on,
        workingDays: tenants.working_days,
        workStart: tenants.default_work_start,
        workEnd: tenants.default_work_end,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    // tenants.working_days stores 'MON'.. codes; the web wants 0=Sun..6=Sat.
    const DOW: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
    const workingDays = Array.isArray(t?.workingDays)
      ? (t!.workingDays as unknown[])
          .map((d) => (typeof d === 'number' ? d : DOW[String(d).toUpperCase().slice(0, 3)]))
          .filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6)
      : [1, 2, 3, 4, 5];
    return {
      name: t?.name ?? 'Workspace',
      timezone: isValidTimezone(t?.timezone) ? t!.timezone : DEFAULT_TZ,
      weekStartsOn: typeof t?.weekStartsOn === 'number' ? t.weekStartsOn : 1,
      workingDays: workingDays.length ? workingDays : [1, 2, 3, 4, 5],
      workStart: t?.workStart ?? '09:00',
      workEnd: t?.workEnd ?? '18:00',
    };
  }

  // ─── Feed ───────────────────────────────────────────────────────────────────

  private validateRange(from: string, to: string): void {
    const f = new Date(`${from}T00:00:00Z`);
    const t = new Date(`${to}T00:00:00Z`);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime()) || f.toISOString().slice(0, 10) !== from || t.toISOString().slice(0, 10) !== to) {
      throw new BadRequestException('from/to must be valid YYYY-MM-DD dates');
    }
    if (t < f) throw new BadRequestException('to must not be before from');
    const days = Math.round((t.getTime() - f.getTime()) / 86_400_000) + 1;
    if (days > MAX_RANGE_DAYS) {
      throw new BadRequestException(`Range too large (max ${MAX_RANGE_DAYS} days)`);
    }
  }

  /**
   * Unified feed for `[from, to]` (inclusive calendar days): holidays, my
   * leave, team leave (availability scope), birthdays & work anniversaries,
   * my CRM calls & meetings, and user-authored events/meetings. One tenant
   * transaction; CRM rows come through the CRM facade after it commits.
   */
  async listFeed(user: JwtPayload, from: string, to: string): Promise<CalendarFeed> {
    const role = this.roleHint(user);
    this.assertWorkspaceSeat(role);
    this.validateRange(from, to);
    const tenantId = user.tenantId;
    const userId = user.sub;

    // Timed rows are compared as instants: widen the day window by one day on
    // each side so a zone ahead of / behind UTC never loses an edge item, then
    // trim on the item's own local dates below.
    const instantFrom = new Date(`${addDaysISO(from, -1)}T00:00:00Z`);
    const instantTo = new Date(`${addDaysISO(to, 2)}T00:00:00Z`);

    const result = await this.databaseService.withTenant(
      tenantId,
      async (tx) => {
        const viewer = await this.resolveViewer(tx, tenantId, userId, role);
        const prefs = await this.loadPrefs(tx, tenantId);
        const items: CalendarFeedItem[] = [];

        // 1. Holidays — company-wide plus the viewer's own location.
        const holidayRows = await tx
          .select({
            id: holidays.id,
            date: holidays.holiday_date,
            name: holidays.name,
            type: holidays.type,
            description: holidays.description,
            locationId: holidays.location_id,
          })
          .from(holidays)
          .where(
            and(
              eq(holidays.tenant_id, tenantId),
              gte(holidays.holiday_date, from),
              lte(holidays.holiday_date, to),
              viewer.locationId
                ? or(isNull(holidays.location_id), eq(holidays.location_id, viewer.locationId))
                : isNull(holidays.location_id),
            ),
          )
          .orderBy(asc(holidays.holiday_date));
        for (const h of holidayRows) {
          items.push({
            ...this.allDayShell(h.date, h.date, prefs.timezone),
            id: `holiday:${h.id}`,
            type: 'holiday',
            title: h.name,
            color: COLORS.holiday,
            description: h.description,
            canEdit: false,
            meta: {
              holidayType: h.type,
              blocking: !['optional', 'restricted'].includes(h.type),
              locationScoped: !!h.locationId,
            },
          });
        }

        // 2. My leave — any status (pending shows as pending).
        if (viewer.employeeId) {
          const myLeaves = await tx
            .select({
              id: leaveRequests.id,
              startDate: leaveRequests.start_date,
              endDate: leaveRequests.end_date,
              status: leaveRequests.status,
              totalDays: leaveRequests.total_days,
              leaveTypeName: leaveTypes.name,
              leaveTypeCode: leaveTypes.code,
              leaveTypeColor: leaveTypes.color,
            })
            .from(leaveRequests)
            .leftJoin(
              leaveTypes,
              and(eq(leaveRequests.leave_type_id, leaveTypes.id), eq(leaveTypes.tenant_id, tenantId)),
            )
            .where(
              and(
                eq(leaveRequests.tenant_id, tenantId),
                eq(leaveRequests.employee_id, viewer.employeeId),
                lte(leaveRequests.start_date, to),
                gte(leaveRequests.end_date, from),
              ),
            );
          for (const l of myLeaves) {
            items.push({
              ...this.allDayShell(l.startDate, l.endDate, prefs.timezone),
              id: `my_leave:${l.id}`,
              type: 'my_leave',
              title: `${l.leaveTypeCode ?? 'Leave'}${l.status === 'pending' ? ' · pending' : ''}`,
              status: l.status,
              color: l.leaveTypeColor ?? COLORS.myLeave,
              canEdit: false,
              link: '/leave',
              meta: { leaveTypeName: l.leaveTypeName, totalDays: l.totalDays },
            });
          }
        }

        // 3. Team leave — approved only, availability scope, never the reason.
        const scope = this.availabilityScope(viewer);
        const teamLeaves = await tx
          .select({
            id: leaveRequests.id,
            startDate: leaveRequests.start_date,
            endDate: leaveRequests.end_date,
            totalDays: leaveRequests.total_days,
            employeeId: employees.id,
            employeeUserId: employees.user_id,
            employeeName: sql<string>`${employees.first_name} || ' ' || ${employees.last_name}`,
            leaveTypeName: leaveTypes.name,
            leaveTypeCode: leaveTypes.code,
          })
          .from(leaveRequests)
          .innerJoin(
            employees,
            and(eq(leaveRequests.employee_id, employees.id), eq(employees.tenant_id, tenantId)),
          )
          .leftJoin(
            leaveTypes,
            and(eq(leaveRequests.leave_type_id, leaveTypes.id), eq(leaveTypes.tenant_id, tenantId)),
          )
          .where(
            and(
              eq(leaveRequests.tenant_id, tenantId),
              eq(leaveRequests.status, 'approved'),
              isNull(employees.deleted_at),
              sql`${employees.user_id} IS DISTINCT FROM ${userId}`,
              scope,
              lte(leaveRequests.start_date, to),
              gte(leaveRequests.end_date, from),
            ),
          );
        for (const l of teamLeaves) {
          items.push({
            ...this.allDayShell(l.startDate, l.endDate, prefs.timezone),
            id: `team_leave:${l.id}`,
            type: 'team_leave',
            title: `${l.employeeName} · ${l.leaveTypeCode ?? 'Leave'}`,
            status: 'approved',
            color: COLORS.teamLeave,
            canEdit: false,
            meta: {
              employeeId: l.employeeId,
              employeeUserId: l.employeeUserId,
              employeeName: l.employeeName,
              leaveTypeName: l.leaveTypeName,
              totalDays: l.totalDays,
            },
          });
        }

        // 4. Birthdays & work anniversaries — availability scope plus self.
        const selfOr = viewer.employeeId
          ? sql`(${scope} OR ${employees.id} = ${viewer.employeeId})`
          : scope;
        const people = await tx
          .select({
            id: employees.id,
            userId: employees.user_id,
            name: sql<string>`${employees.first_name} || ' ' || ${employees.last_name}`,
            dob: employees.date_of_birth,
            doj: employees.date_of_joining,
          })
          .from(employees)
          .where(
            and(
              eq(employees.tenant_id, tenantId),
              isNull(employees.deleted_at),
              inArray(employees.status, [...PRESENT_EMPLOYEE_STATUSES]),
              selfOr,
              or(isNotNull(employees.date_of_birth), isNotNull(employees.date_of_joining)),
            ),
          );
        const canOpenProfiles = PROFILE_ROLES.includes(viewer.role);
        for (const p of people) {
          const isSelf = p.id === viewer.employeeId;
          const first = p.name.split(' ')[0] || p.name;
          if (p.dob) {
            for (const occ of this.occurrencesInRange(p.dob, from, to, false)) {
              items.push({
                ...this.allDayShell(occ.date, occ.date, prefs.timezone),
                id: `birthday:${p.id}:${occ.date}`,
                type: 'birthday',
                title: isSelf ? '🎂 Your birthday' : `🎂 ${first}'s birthday`,
                color: COLORS.birthday,
                canEdit: false,
                ...(canOpenProfiles && !isSelf ? { link: `/employees/${p.id}` } : {}),
                meta: { employeeId: p.id, employeeUserId: p.userId, employeeName: p.name },
              });
            }
          }
          if (p.doj) {
            for (const occ of this.occurrencesInRange(p.doj, from, to, true)) {
              const yrs = occ.years;
              items.push({
                ...this.allDayShell(occ.date, occ.date, prefs.timezone),
                id: `anniversary:${p.id}:${occ.date}`,
                type: 'anniversary',
                title: isSelf
                  ? `🎉 ${yrs} ${yrs === 1 ? 'year' : 'years'} at ${prefs.name}`
                  : `🎉 ${first} · ${yrs} ${yrs === 1 ? 'year' : 'years'} at ${prefs.name}`,
                color: COLORS.anniversary,
                canEdit: false,
                ...(canOpenProfiles && !isSelf ? { link: `/employees/${p.id}` } : {}),
                meta: { employeeId: p.id, employeeUserId: p.userId, employeeName: p.name, years: yrs },
              });
            }
          }
        }

        // 5. Events & meetings.
        const eventRows = await tx
          .select(this.eventColumns())
          .from(calendarEvents)
          .where(
            and(
              eq(calendarEvents.tenant_id, tenantId),
              eq(calendarEvents.event_type, 'company_event'),
              isNull(calendarEvents.cancelled_at),
              lt(calendarEvents.start_at, instantTo),
              gt(calendarEvents.end_at, instantFrom),
              this.visibleEventPredicate(tenantId, viewer),
            ),
          )
          .orderBy(asc(calendarEvents.start_at))
          .limit(1000);
        const attendeesByEvent = await this.loadAttendees(
          tx,
          tenantId,
          eventRows.map((e) => e.id),
        );
        const organizers = await this.loadOrganizers(
          tx,
          tenantId,
          eventRows.map((e) => e.organizer_user_id).filter((x): x is string => !!x),
        );
        for (const e of eventRows) {
          items.push(await this.toEventItem(e, attendeesByEvent.get(e.id) ?? [], organizers, viewer));
        }

        return { viewer, prefs, items };
      },
      userId,
    );

    // 6. CRM calls & meetings — after the tenant tx, via the facade, only for
    // members who hold any CRM access (same resolution CrmGrantGuard makes).
    let crmAllowed = false;
    try {
      const access = await this.moduleAccess.resolve(
        tenantId,
        user.membershipId,
        role as UserRole,
        'crm',
        userId,
      );
      crmAllowed = access.level !== 'none' && access.moduleEnabled !== false;
    } catch (err) {
      this.logger.warn(`CRM access check failed for calendar feed: ${err instanceof Error ? err.message : err}`);
    }
    if (crmAllowed) {
      try {
        const acts = await this.crm.listMyScheduledActivities(tenantId, userId, instantFrom, instantTo);
        for (const a of acts) {
          if (!a.due_at) continue;
          const start = new Date(a.due_at);
          const end = new Date(start.getTime() + 30 * 60_000);
          const tz = result.prefs.timezone;
          result.items.push({
            id: `crm_activity:${a.id}`,
            type: 'crm_activity',
            title: `${a.type === 'call' ? '📞' : '🤝'} ${a.subject || (a.type === 'call' ? 'Call' : 'Meeting')}`,
            allDay: false,
            startAt: start.toISOString(),
            endAt: end.toISOString(),
            startDate: dateInTimezone(start, tz),
            endDate: dateInTimezone(new Date(end.getTime() - 1), tz),
            timezone: tz,
            color: COLORS.crm,
            status: a.completed_at ? 'completed' : 'scheduled',
            canEdit: false,
            link: a.deal_id ? `/crm/deals/${a.deal_id}` : '/crm/activities',
            meta: {
              activityType: a.type,
              completed: !!a.completed_at,
              dealId: a.deal_id,
              dealTitle: a.deal_title,
            },
          });
        }
      } catch (err) {
        this.logger.warn(`CRM activities for calendar feed failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Trim the widened instant window on local dates, then sort.
    const data = result.items
      .filter((it) => it.startDate <= to && it.endDate >= from)
      .sort((a, b) => {
        if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
        return a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : a.title.localeCompare(b.title);
      });

    const { name: _n, ...prefs } = result.prefs;
    return { data, prefs, sources: { crm: crmAllowed } };
  }

  // ─── Event detail ───────────────────────────────────────────────────────────

  async getEvent(user: JwtPayload, id: string): Promise<{ data: CalendarFeedItem }> {
    const role = this.roleHint(user);
    this.assertWorkspaceSeat(role);
    const tenantId = user.tenantId;
    return this.databaseService.withTenant(
      tenantId,
      async (tx) => {
        const viewer = await this.resolveViewer(tx, tenantId, user.sub, role);
        const row = await this.loadVisibleEvent(tx, tenantId, viewer, id);
        if (!row) throw new NotFoundException('Event not found');
        const attendees = await this.loadAttendees(tx, tenantId, [row.id]);
        const organizers = await this.loadOrganizers(tx, tenantId, row.organizer_user_id ? [row.organizer_user_id] : []);
        return { data: await this.toEventItem(row, attendees.get(row.id) ?? [], organizers, viewer) };
      },
      user.sub,
    );
  }

  // ─── Create ─────────────────────────────────────────────────────────────────

  async createEvent(user: JwtPayload, dto: CreateCalendarEventDto): Promise<{ data: CalendarFeedItem }> {
    const role = this.roleHint(user);
    this.assertWorkspaceSeat(role);
    const tenantId = user.tenantId;
    const userId = user.sub;

    // Pre-tx: tenant zone default + validation + (future) link generation.
    const tenantTz = await this.tenantTimezone(tenantId, userId);
    const timing = this.resolveTiming(dto, dto.timezone ?? tenantTz);
    const provider = this.resolveProvider(dto.meetingProvider, dto.meetingUrl);
    let meetingUrl = provider.url;
    if (!meetingUrl && (provider.provider === 'teams' || provider.provider === 'google_meet')) {
      // No network inside the tx (house rule 7): generation happens here, and
      // returns null until an account is connected (Round K).
      meetingUrl = await this.meetingLinks.generate(provider.provider, tenantId, userId, {
        title: dto.title,
        startAt: timing.startAt,
        endAt: timing.endAt,
        timezone: timing.timezone,
      });
    }
    const wantedAttendees = this.dedupeAttendees(dto.attendees ?? [], userId);

    const created = await this.databaseService.withTenant(
      tenantId,
      async (tx) => {
        const viewer = await this.resolveViewer(tx, tenantId, userId, role);
        await this.assertAttendeesInTenant(tx, tenantId, wantedAttendees.map((a) => a.userId));

        const [row] = await tx
          .insert(calendarEvents)
          .values({
            tenant_id: tenantId,
            event_type: 'company_event',
            kind: dto.kind,
            title: dto.title.trim(),
            description: dto.description?.trim() || null,
            location: dto.location?.trim() || null,
            start_at: timing.startAt,
            end_at: timing.endAt,
            is_all_day: timing.allDay,
            timezone: timing.timezone,
            visibility: dto.visibility ?? 'private',
            color: dto.color ?? null,
            meeting_provider: provider.provider,
            meeting_url: meetingUrl ?? null,
            organizer_user_id: userId,
            employee_id: viewer.employeeId,
            created_by: userId,
            updated_by: userId,
          })
          .returning(this.eventColumns());

        await tx.insert(calendarEventAttendees).values([
          { tenant_id: tenantId, event_id: row.id, user_id: userId, is_optional: false, response: 'accepted', responded_at: new Date() },
          ...wantedAttendees.map((a) => ({
            tenant_id: tenantId,
            event_id: row.id,
            user_id: a.userId,
            is_optional: !!a.isOptional,
            response: 'pending',
          })),
        ]);

        await this.domainEvents.publish(
          {
            name: 'calendar.event.created',
            tenantId,
            actorUserId: userId,
            payload: {
              event_id: row.id,
              kind: row.kind,
              provider: row.meeting_provider,
              all_day: row.is_all_day,
              attendee_count: wantedAttendees.length,
            },
          },
          tx,
        );

        const attendees = await this.loadAttendees(tx, tenantId, [row.id]);
        const organizers = await this.loadOrganizers(tx, tenantId, [userId]);
        const item = await this.toEventItem(row, attendees.get(row.id) ?? [], organizers, viewer);
        return { row, item, viewer, attendeeRows: attendees.get(row.id) ?? [] };
      },
      userId,
    );

    this.afterWrite(tenantId, userId, 'calendar.event.create', created.row, { kind: created.row.kind });
    void this.notifyAttendees(
      'invited',
      tenantId,
      created.viewer,
      created.row,
      created.attendeeRows.filter((a) => a.user_id !== userId),
    );
    return { data: created.item };
  }

  // ─── Update ─────────────────────────────────────────────────────────────────

  async updateEvent(user: JwtPayload, id: string, dto: UpdateCalendarEventDto): Promise<{ data: CalendarFeedItem }> {
    const role = this.roleHint(user);
    this.assertWorkspaceSeat(role);
    const tenantId = user.tenantId;
    const userId = user.sub;
    const tenantTz = await this.tenantTimezone(tenantId, userId);

    const updated = await this.databaseService.withTenant(
      tenantId,
      async (tx) => {
        const viewer = await this.resolveViewer(tx, tenantId, userId, role);
        const before = await this.loadVisibleEvent(tx, tenantId, viewer, id);
        if (!before) throw new NotFoundException('Event not found');
        this.assertCanManage(before, viewer);
        if (before.cancelled_at) throw new BadRequestException('This event was cancelled');

        // Timing: merge dto over the stored row.
        const allDay = dto.allDay ?? before.is_all_day;
        const tz = dto.timezone ?? before.timezone ?? tenantTz;
        let timing: { startAt: Date; endAt: Date; allDay: boolean; timezone: string };
        const touchesTiming =
          dto.allDay !== undefined || dto.startAt !== undefined || dto.endAt !== undefined ||
          dto.startDate !== undefined || dto.endDate !== undefined || dto.timezone !== undefined;
        if (touchesTiming) {
          if (allDay) {
            const startDate = dto.startDate ?? (before.is_all_day ? before.start_at.toISOString().slice(0, 10) : dateInTimezone(before.start_at, tz));
            const endDate = dto.endDate ?? (dto.startDate ? dto.startDate : before.is_all_day ? new Date(before.end_at.getTime() - 1).toISOString().slice(0, 10) : dateInTimezone(before.end_at, tz));
            timing = this.resolveTiming({ allDay: true, startDate, endDate, timezone: tz }, tz);
          } else {
            const startAt = dto.startAt ?? before.start_at.toISOString();
            const endAt = dto.endAt ?? (dto.startAt && !dto.endAt
              ? new Date(new Date(dto.startAt).getTime() + Math.max(before.end_at.getTime() - before.start_at.getTime(), 30 * 60_000)).toISOString()
              : before.end_at.toISOString());
            timing = this.resolveTiming({ allDay: false, startAt, endAt, timezone: tz }, tz);
          }
        } else {
          timing = { startAt: before.start_at, endAt: before.end_at, allDay: before.is_all_day, timezone: before.timezone };
        }

        // Provider / URL: merge, then re-validate as a pair.
        const providerIn = dto.meetingProvider ?? (before.meeting_provider as MeetingProvider);
        const urlIn = dto.meetingUrl !== undefined ? dto.meetingUrl : before.meeting_url;
        const provider = this.resolveProvider(providerIn, urlIn ?? undefined);

        const patch: Partial<typeof calendarEvents.$inferInsert> = {
          updated_at: new Date(),
          updated_by: userId,
          start_at: timing.startAt,
          end_at: timing.endAt,
          is_all_day: timing.allDay,
          timezone: timing.timezone,
          meeting_provider: provider.provider,
          meeting_url: provider.url ?? null,
        };
        if (dto.kind !== undefined) patch.kind = dto.kind;
        if (dto.title !== undefined) patch.title = dto.title.trim();
        if (dto.description !== undefined) patch.description = dto.description?.trim() || null;
        if (dto.location !== undefined) patch.location = dto.location?.trim() || null;
        if (dto.visibility !== undefined) patch.visibility = dto.visibility;
        if (dto.color !== undefined) patch.color = dto.color ?? null;

        const [row] = await tx
          .update(calendarEvents)
          .set(patch)
          .where(and(eq(calendarEvents.id, id), eq(calendarEvents.tenant_id, tenantId)))
          .returning(this.eventColumns());

        // Attendee delta (organizer always stays).
        const existing = await this.loadAttendees(tx, tenantId, [id]);
        const existingRows = existing.get(id) ?? [];
        let added: string[] = [];
        let removed: AttendeeRow[] = [];
        if (dto.attendees !== undefined) {
          const organizerId = row.organizer_user_id ?? userId;
          const wanted = this.dedupeAttendees(dto.attendees, organizerId);
          await this.assertAttendeesInTenant(tx, tenantId, wanted.map((a) => a.userId));
          const wantedIds = new Set(wanted.map((a) => a.userId));
          const existingIds = new Set(existingRows.map((a) => a.user_id));
          removed = existingRows.filter((a) => a.user_id !== organizerId && !wantedIds.has(a.user_id));
          added = wanted.filter((a) => !existingIds.has(a.userId)).map((a) => a.userId);
          if (removed.length) {
            await tx
              .delete(calendarEventAttendees)
              .where(
                and(
                  eq(calendarEventAttendees.tenant_id, tenantId),
                  eq(calendarEventAttendees.event_id, id),
                  inArray(calendarEventAttendees.user_id, removed.map((a) => a.user_id)),
                ),
              );
          }
          if (added.length) {
            await tx.insert(calendarEventAttendees).values(
              wanted
                .filter((a) => added.includes(a.userId))
                .map((a) => ({
                  tenant_id: tenantId,
                  event_id: id,
                  user_id: a.userId,
                  is_optional: !!a.isOptional,
                  response: 'pending',
                })),
            );
          }
          // Optional flag changes on kept rows.
          for (const a of wanted) {
            const cur = existingRows.find((r) => r.user_id === a.userId);
            if (cur && cur.is_optional !== !!a.isOptional) {
              await tx
                .update(calendarEventAttendees)
                .set({ is_optional: !!a.isOptional })
                .where(
                  and(
                    eq(calendarEventAttendees.tenant_id, tenantId),
                    eq(calendarEventAttendees.event_id, id),
                    eq(calendarEventAttendees.user_id, a.userId),
                  ),
                );
            }
          }
        }

        const materiallyChanged =
          before.start_at.getTime() !== row.start_at.getTime() ||
          before.end_at.getTime() !== row.end_at.getTime() ||
          before.is_all_day !== row.is_all_day ||
          (before.location ?? '') !== (row.location ?? '') ||
          (before.meeting_url ?? '') !== (row.meeting_url ?? '') ||
          before.meeting_provider !== row.meeting_provider ||
          before.title !== row.title;

        await this.domainEvents.publish(
          {
            name: 'calendar.event.updated',
            tenantId,
            actorUserId: userId,
            payload: {
              event_id: id,
              kind: row.kind,
              provider: row.meeting_provider,
              added_count: added.length,
              removed_count: removed.length,
              rescheduled: before.start_at.getTime() !== row.start_at.getTime() || before.end_at.getTime() !== row.end_at.getTime(),
            },
          },
          tx,
        );

        const after = await this.loadAttendees(tx, tenantId, [id]);
        const afterRows = after.get(id) ?? [];
        const organizers = await this.loadOrganizers(tx, tenantId, row.organizer_user_id ? [row.organizer_user_id] : []);
        const item = await this.toEventItem(row, afterRows, organizers, viewer);
        return { before, row, item, viewer, afterRows, added, removed, materiallyChanged };
      },
      userId,
    );

    this.afterWrite(tenantId, userId, 'calendar.event.update', updated.row, {
      before: this.auditSnapshot(updated.before),
    });
    const actorless = (rows: AttendeeRow[]) => rows.filter((a) => a.user_id !== userId);
    const addedRows = updated.afterRows.filter((a) => updated.added.includes(a.user_id));
    const keptRows = updated.afterRows.filter((a) => !updated.added.includes(a.user_id));
    if (addedRows.length) void this.notifyAttendees('invited', tenantId, updated.viewer, updated.row, actorless(addedRows));
    if (updated.removed.length) void this.notifyAttendees('cancelled', tenantId, updated.viewer, updated.before, actorless(updated.removed), true);
    if (updated.materiallyChanged && keptRows.length) {
      void this.notifyAttendees('updated', tenantId, updated.viewer, updated.row, actorless(keptRows));
    }
    return { data: updated.item };
  }

  // ─── Cancel ─────────────────────────────────────────────────────────────────

  async cancelEvent(user: JwtPayload, id: string): Promise<{ data: { id: string; cancelledAt: string } }> {
    const role = this.roleHint(user);
    this.assertWorkspaceSeat(role);
    const tenantId = user.tenantId;
    const userId = user.sub;

    const res = await this.databaseService.withTenant(
      tenantId,
      async (tx) => {
        const viewer = await this.resolveViewer(tx, tenantId, userId, role);
        const before = await this.loadVisibleEvent(tx, tenantId, viewer, id);
        if (!before) throw new NotFoundException('Event not found');
        this.assertCanManage(before, viewer);
        if (before.cancelled_at) {
          return { row: before, viewer, attendeeRows: [] as AttendeeRow[], already: true };
        }
        const [row] = await tx
          .update(calendarEvents)
          .set({ cancelled_at: new Date(), updated_at: new Date(), updated_by: userId })
          .where(and(eq(calendarEvents.id, id), eq(calendarEvents.tenant_id, tenantId)))
          .returning(this.eventColumns());
        await this.domainEvents.publish(
          { name: 'calendar.event.cancelled', tenantId, actorUserId: userId, payload: { event_id: id, kind: row.kind } },
          tx,
        );
        const attendees = await this.loadAttendees(tx, tenantId, [id]);
        return { row, viewer, attendeeRows: attendees.get(id) ?? [], already: false };
      },
      userId,
    );

    if (!res.already) {
      this.afterWrite(tenantId, userId, 'calendar.event.cancel', res.row, {});
      void this.notifyAttendees(
        'cancelled',
        tenantId,
        res.viewer,
        res.row,
        res.attendeeRows.filter((a) => a.user_id !== userId),
      );
    }
    return { data: { id: res.row.id, cancelledAt: (res.row.cancelled_at ?? new Date()).toISOString() } };
  }

  // ─── RSVP ───────────────────────────────────────────────────────────────────

  async rsvp(user: JwtPayload, id: string, dto: RsvpDto): Promise<{ data: CalendarFeedItem }> {
    const role = this.roleHint(user);
    this.assertWorkspaceSeat(role);
    const tenantId = user.tenantId;
    const userId = user.sub;
    if (!(['accepted', 'declined', 'tentative'] as string[]).includes(dto.response)) {
      throw new BadRequestException('Invalid response');
    }

    const res = await this.databaseService.withTenant(
      tenantId,
      async (tx) => {
        const viewer = await this.resolveViewer(tx, tenantId, userId, role);
        const [row] = await tx
          .select(this.eventColumns())
          .from(calendarEvents)
          .where(and(eq(calendarEvents.id, id), eq(calendarEvents.tenant_id, tenantId)))
          .limit(1);
        if (!row) throw new NotFoundException('Event not found');
        const [mine] = await tx
          .select({ id: calendarEventAttendees.id, response: calendarEventAttendees.response })
          .from(calendarEventAttendees)
          .where(
            and(
              eq(calendarEventAttendees.tenant_id, tenantId),
              eq(calendarEventAttendees.event_id, id),
              eq(calendarEventAttendees.user_id, userId),
            ),
          )
          .limit(1);
        if (!mine) throw new ForbiddenException('You are not on the invite list');
        if (row.cancelled_at) throw new BadRequestException('This event was cancelled');

        await tx
          .update(calendarEventAttendees)
          .set({ response: dto.response, responded_at: new Date() })
          .where(and(eq(calendarEventAttendees.id, mine.id), eq(calendarEventAttendees.tenant_id, tenantId)));
        await this.domainEvents.publish(
          {
            name: 'calendar.event.rsvp',
            tenantId,
            actorUserId: userId,
            payload: { event_id: id, response: dto.response, previous: mine.response },
          },
          tx,
        );
        const attendees = await this.loadAttendees(tx, tenantId, [id]);
        const organizers = await this.loadOrganizers(tx, tenantId, row.organizer_user_id ? [row.organizer_user_id] : []);
        const item = await this.toEventItem(row, attendees.get(id) ?? [], organizers, viewer);
        return { row, item, viewer };
      },
      userId,
    );

    this.eventEmitter.emit('calendar.changed', { tenantId, eventId: id });
    const organizerId = res.row.organizer_user_id;
    if (organizerId && organizerId !== userId) {
      const verb = dto.response === 'accepted' ? 'accepted' : dto.response === 'declined' ? 'declined' : 'tentatively accepted';
      void this.notifications.createInAppNotification(
        organizerId,
        'calendar.event.rsvp',
        `${res.viewer.name} ${verb} "${res.row.title}"`,
        this.eventLink(res.row),
        tenantId,
        { groupKey: `rsvp:${id}` },
      );
    }
    return { data: res.item };
  }

  // ─── People (invite picker) ─────────────────────────────────────────────────

  async listPeople(user: JwtPayload, q?: string): Promise<{ data: InvitablePerson[] }> {
    const role = this.roleHint(user);
    this.assertWorkspaceSeat(role);
    const tenantId = user.tenantId;
    const needle = (q ?? '').trim();
    const like = needle ? `%${needle.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;

    const rows = await this.databaseService.withTenant(
      tenantId,
      (tx) =>
        tx
          .select({
            userId: users.id,
            name: users.full_name,
            email: users.email,
            avatarKey: users.avatar_key,
            avatarUrl: users.avatar_url,
            departmentName: departments.name,
          })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.user_id))
          .leftJoin(
            employees,
            and(eq(employees.id, memberships.employee_id), eq(employees.tenant_id, tenantId), isNull(employees.deleted_at)),
          )
          .leftJoin(
            departments,
            and(eq(departments.id, employees.department_id), eq(departments.tenant_id, tenantId)),
          )
          .where(
            and(
              eq(memberships.tenant_id, tenantId),
              eq(memberships.status, 'active'),
              sql`${memberships.role} NOT IN ('guest', 'auditor')`,
              eq(users.status, 'active'),
              like
                ? or(sql`${users.full_name} ILIKE ${like} ESCAPE '\\'`, sql`${users.email} ILIKE ${like} ESCAPE '\\'`)
                : sql`true`,
            ),
          )
          .orderBy(asc(users.full_name))
          .limit(200),
      user.sub,
    );
    const data = await Promise.all(
      rows.map(async (r) => ({
        userId: r.userId,
        name: r.name,
        email: r.email,
        avatarUrl: await this.media.servedUrl(r.avatarKey, r.avatarUrl, 64),
        departmentName: r.departmentName ?? null,
      })),
    );
    return { data };
  }

  // ─── Validation helpers ─────────────────────────────────────────────────────

  private async tenantTimezone(tenantId: string, userId: string): Promise<string> {
    const [t] = await this.databaseService.withTenant(
      tenantId,
      (tx) => tx.select({ tz: tenants.timezone }).from(tenants).where(eq(tenants.id, tenantId)).limit(1),
      userId,
    );
    return isValidTimezone(t?.tz) ? t!.tz : DEFAULT_TZ;
  }

  /**
   * Normalises the two authoring modes into stored instants. All-day rows are
   * UTC midnights with an exclusive end (timezone-independent dates); timed
   * rows are real instants plus the authoring zone.
   */
  private resolveTiming(
    dto: Pick<CreateCalendarEventDto, 'allDay' | 'startDate' | 'endDate' | 'startAt' | 'endAt' | 'timezone'>,
    fallbackTz: string,
  ): { startAt: Date; endAt: Date; allDay: boolean; timezone: string } {
    const tz = dto.timezone ?? fallbackTz;
    if (!isValidTimezone(tz)) throw new BadRequestException('Unknown timezone');
    if (dto.allDay) {
      const s = dto.startDate;
      const e = dto.endDate ?? dto.startDate;
      if (!s || !e || !/^\d{4}-\d{2}-\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}$/.test(e)) {
        throw new BadRequestException('All-day events need startDate (and optionally endDate)');
      }
      const startAt = new Date(`${s}T00:00:00Z`);
      const endAt = new Date(`${addDaysISO(e, 1)}T00:00:00Z`);
      if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
        throw new BadRequestException('Invalid all-day dates');
      }
      if (endAt <= startAt) throw new BadRequestException('endDate must be on or after startDate');
      const days = Math.round((endAt.getTime() - startAt.getTime()) / 86_400_000);
      if (days > MAX_ALLDAY_DAYS) throw new BadRequestException(`All-day events can span at most ${MAX_ALLDAY_DAYS} days`);
      return { startAt, endAt, allDay: true, timezone: tz };
    }
    if (!dto.startAt || !dto.endAt) throw new BadRequestException('Timed events need startAt and endAt');
    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
      throw new BadRequestException('startAt/endAt must be ISO-8601 instants');
    }
    if (endAt <= startAt) throw new BadRequestException('End must be after start');
    if (endAt.getTime() - startAt.getTime() > MAX_TIMED_DAYS * 86_400_000) {
      throw new BadRequestException(`Timed events can span at most ${MAX_TIMED_DAYS} days`);
    }
    return { startAt, endAt, allDay: false, timezone: tz };
  }

  /** Provider + URL as a validated pair (host rules; none+URL → other). */
  private resolveProvider(
    providerIn: MeetingProvider | undefined,
    urlIn: string | undefined | null,
  ): { provider: MeetingProvider; url: string | null } {
    let provider: MeetingProvider = providerIn ?? 'none';
    if (!MEETING_PROVIDERS.includes(provider)) throw new BadRequestException('Unknown meeting provider');
    const url = (urlIn ?? '').trim() || null;
    if (url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new BadRequestException('Meeting link must be a valid https URL');
      }
      if (parsed.protocol !== 'https:') throw new BadRequestException('Meeting link must use https');
      const host = parsed.hostname.toLowerCase();
      if (provider === 'teams' || provider === 'google_meet') {
        const ok = PROVIDER_HOSTS[provider].some((h) => host === h || host.endsWith(`.${h}`));
        if (!ok) {
          throw new BadRequestException(
            provider === 'teams'
              ? 'A Microsoft Teams link must point at teams.microsoft.com'
              : 'A Google Meet link must point at meet.google.com',
          );
        }
      }
      if (provider === 'none') provider = 'other';
    }
    return { provider, url };
  }

  private dedupeAttendees(list: AttendeeInputDto[], organizerId: string): AttendeeInputDto[] {
    const seen = new Set<string>([organizerId]);
    const out: AttendeeInputDto[] = [];
    for (const a of list) {
      if (!a?.userId || seen.has(a.userId)) continue;
      seen.add(a.userId);
      out.push({ userId: a.userId, isOptional: !!a.isOptional });
    }
    return out;
  }

  /**
   * FK checks bypass RLS (house rule 2): every invitee must hold an ACTIVE
   * workspace seat in THIS tenant that is neither a guest nor an auditor.
   */
  private async assertAttendeesInTenant(tx: Db, tenantId: string, userIds: string[]): Promise<void> {
    if (!userIds.length) return;
    const rows = await tx
      .select({ userId: memberships.user_id })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenant_id, tenantId),
          inArray(memberships.user_id, userIds),
          eq(memberships.status, 'active'),
          sql`${memberships.role} NOT IN ('guest', 'auditor')`,
        ),
      );
    const ok = new Set(rows.map((r) => r.userId));
    const missing = userIds.filter((id) => !ok.has(id));
    if (missing.length) {
      throw new BadRequestException(
        missing.length === 1
          ? 'One invitee is not an active member of this workspace'
          : `${missing.length} invitees are not active members of this workspace`,
      );
    }
  }

  private assertCanManage(row: EventRow, viewer: Viewer): void {
    if (row.organizer_user_id === viewer.userId || viewer.orgWide) return;
    throw new ForbiddenException('Only the organizer can change this event');
  }

  // ─── Row loaders ────────────────────────────────────────────────────────────

  private eventColumns() {
    return {
      id: calendarEvents.id,
      tenant_id: calendarEvents.tenant_id,
      kind: calendarEvents.kind,
      title: calendarEvents.title,
      description: calendarEvents.description,
      location: calendarEvents.location,
      start_at: calendarEvents.start_at,
      end_at: calendarEvents.end_at,
      is_all_day: calendarEvents.is_all_day,
      timezone: calendarEvents.timezone,
      visibility: calendarEvents.visibility,
      color: calendarEvents.color,
      meeting_provider: calendarEvents.meeting_provider,
      meeting_url: calendarEvents.meeting_url,
      organizer_user_id: calendarEvents.organizer_user_id,
      cancelled_at: calendarEvents.cancelled_at,
      created_at: calendarEvents.created_at,
      updated_at: calendarEvents.updated_at,
    };
  }

  private async loadVisibleEvent(tx: Db, tenantId: string, viewer: Viewer, id: string): Promise<EventRow | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const [row] = await tx
      .select(this.eventColumns())
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.id, id),
          eq(calendarEvents.tenant_id, tenantId),
          eq(calendarEvents.event_type, 'company_event'),
          this.visibleEventPredicate(tenantId, viewer),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  private async loadAttendees(tx: Db, tenantId: string, eventIds: string[]): Promise<Map<string, AttendeeRow[]>> {
    const map = new Map<string, AttendeeRow[]>();
    if (!eventIds.length) return map;
    const rows = await tx
      .select({
        event_id: calendarEventAttendees.event_id,
        user_id: calendarEventAttendees.user_id,
        is_optional: calendarEventAttendees.is_optional,
        response: calendarEventAttendees.response,
        created_at: calendarEventAttendees.created_at,
        name: users.full_name,
        email: users.email,
        avatar_key: users.avatar_key,
        avatar_url: users.avatar_url,
        timezone: users.timezone,
      })
      .from(calendarEventAttendees)
      .innerJoin(users, eq(users.id, calendarEventAttendees.user_id))
      .where(
        and(
          eq(calendarEventAttendees.tenant_id, tenantId),
          inArray(calendarEventAttendees.event_id, eventIds),
        ),
      )
      .orderBy(asc(calendarEventAttendees.created_at));
    for (const r of rows) {
      const list = map.get(r.event_id) ?? [];
      list.push(r);
      map.set(r.event_id, list);
    }
    return map;
  }

  private async loadOrganizers(tx: Db, tenantId: string, userIds: string[]): Promise<Map<string, CalendarPerson>> {
    const map = new Map<string, CalendarPerson>();
    const ids = Array.from(new Set(userIds));
    if (!ids.length) return map;
    const rows = await tx
      .select({ id: users.id, name: users.full_name, avatarKey: users.avatar_key, avatarUrl: users.avatar_url })
      .from(users)
      .innerJoin(memberships, and(eq(memberships.user_id, users.id), eq(memberships.tenant_id, tenantId)))
      .where(inArray(users.id, ids));
    for (const r of rows) {
      if (map.has(r.id)) continue;
      map.set(r.id, { userId: r.id, name: r.name, avatarUrl: await this.media.servedUrl(r.avatarKey, r.avatarUrl, 64) });
    }
    return map;
  }

  private async toEventItem(
    e: EventRow,
    attendeeRows: AttendeeRow[],
    organizers: Map<string, CalendarPerson>,
    viewer: Viewer,
  ): Promise<CalendarFeedItem> {
    const attendees: CalendarAttendee[] = [];
    for (const a of attendeeRows) {
      attendees.push({
        userId: a.user_id,
        name: a.name,
        avatarUrl: await this.media.servedUrl(a.avatar_key, a.avatar_url, 64),
        response: (ATTENDEE_RESPONSES.includes(a.response as AttendeeResponse) ? a.response : 'pending') as AttendeeResponse,
        isOptional: a.is_optional,
      });
    }
    const mine = attendeeRows.find((a) => a.user_id === viewer.userId);
    const tz = e.is_all_day ? 'UTC' : e.timezone;
    const lastInstant = new Date(e.end_at.getTime() - 1);
    const provider = (MEETING_PROVIDERS.includes(e.meeting_provider as MeetingProvider) ? e.meeting_provider : 'none') as MeetingProvider;
    return {
      id: e.id,
      type: e.kind === 'meeting' ? 'meeting' : 'event',
      title: e.title,
      allDay: e.is_all_day,
      startAt: e.start_at.toISOString(),
      endAt: e.end_at.toISOString(),
      startDate: e.is_all_day ? e.start_at.toISOString().slice(0, 10) : dateInTimezone(e.start_at, tz),
      endDate: e.is_all_day ? lastInstant.toISOString().slice(0, 10) : dateInTimezone(lastInstant, tz),
      timezone: e.is_all_day ? 'UTC' : e.timezone,
      color: e.color ?? COLORS.event,
      status: e.cancelled_at ? 'cancelled' : 'scheduled',
      description: e.description,
      location: e.location,
      meetingProvider: provider,
      meetingUrl: e.meeting_url,
      visibility: e.visibility,
      organizer: e.organizer_user_id ? organizers.get(e.organizer_user_id) ?? null : null,
      attendees,
      myResponse: mine ? (mine.response as AttendeeResponse) : null,
      canEdit: e.organizer_user_id === viewer.userId || viewer.orgWide,
      meta: {
        kind: e.kind,
        organizerUserId: e.organizer_user_id,
        cancelledAt: e.cancelled_at ? e.cancelled_at.toISOString() : null,
        createdAt: e.created_at.toISOString(),
        updatedAt: e.updated_at.toISOString(),
      },
    };
  }

  /** All-day shell for date-only sources (holiday, leave, birthdays). */
  private allDayShell(startDate: string, endDate: string, tz: string) {
    return {
      allDay: true,
      startAt: `${startDate}T00:00:00.000Z`,
      endAt: `${addDaysISO(endDate, 1)}T00:00:00.000Z`,
      startDate,
      endDate,
      timezone: tz,
    };
  }

  /**
   * Year-agnostic occurrences of a month/day inside [from, to]. Anniversaries
   * skip the joining year itself (0 years is not an anniversary). 29 Feb
   * falls back to 28 Feb in non-leap years.
   */
  private occurrencesInRange(
    baseISO: string,
    from: string,
    to: string,
    skipBaseYear: boolean,
  ): Array<{ date: string; years: number }> {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(baseISO);
    if (!m) return [];
    const baseYear = Number(m[1]);
    const mm = m[2];
    const dd = m[3];
    const out: Array<{ date: string; years: number }> = [];
    const y0 = Number(from.slice(0, 4));
    const y1 = Number(to.slice(0, 4));
    for (let y = y0; y <= y1; y++) {
      if (skipBaseYear && y <= baseYear) continue;
      if (!skipBaseYear && y < baseYear) continue;
      let date = `${y}-${mm}-${dd}`;
      if (mm === '02' && dd === '29') {
        const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
        if (!leap) date = `${y}-02-28`;
      }
      if (date >= from && date <= to) out.push({ date, years: y - baseYear });
    }
    return out;
  }

  // ─── After-commit side effects ──────────────────────────────────────────────

  private eventLink(row: Pick<EventRow, 'id' | 'start_at' | 'is_all_day' | 'timezone'>): string {
    const date = row.is_all_day
      ? row.start_at.toISOString().slice(0, 10)
      : dateInTimezone(row.start_at, isValidTimezone(row.timezone) ? row.timezone : DEFAULT_TZ);
    return `/calendar?event=${row.id}&date=${date}`;
  }

  private auditSnapshot(row: EventRow): Record<string, unknown> {
    return {
      title: row.title,
      start_at: row.start_at.toISOString(),
      end_at: row.end_at.toISOString(),
      is_all_day: row.is_all_day,
      location: row.location,
      meeting_provider: row.meeting_provider,
      meeting_url: row.meeting_url,
      visibility: row.visibility,
    };
  }

  private afterWrite(tenantId: string, userId: string, action: string, row: EventRow, extra: Record<string, unknown>): void {
    void this.audit
      .log({
        tenantId,
        actorUserId: userId,
        action,
        resourceType: 'calendar_event',
        resourceId: row.id,
        afterState: this.auditSnapshot(row),
        metadata: extra,
      })
      .catch((err) => this.logger.warn(`audit ${action} failed: ${err instanceof Error ? err.message : err}`));
    try {
      this.eventEmitter.emit('calendar.changed', { tenantId, eventId: row.id });
    } catch (err) {
      this.logger.warn(`calendar.changed emit failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Best-effort (house rule 6): in-app row + email per attendee, times in the
   * RECIPIENT's zone, invite carries an .ics. Never rejects.
   */
  private async notifyAttendees(
    kind: NotifyKind,
    tenantId: string,
    actor: Viewer,
    row: EventRow,
    recipients: AttendeeRow[],
    removedFromInvite = false,
  ): Promise<void> {
    if (!recipients.length) return;
    const link = this.eventLink(row);
    const inAppType =
      kind === 'invited' ? 'calendar.event.invited' : kind === 'cancelled' ? 'calendar.event.cancelled' : 'calendar.event.updated';
    const template = kind === 'invited' ? 'calendar-invite' : kind === 'cancelled' ? 'calendar-cancelled' : 'calendar-updated';
    const event = kind === 'invited' ? 'calendar_invited' : kind === 'cancelled' ? 'calendar_cancelled' : 'calendar_updated';
    const organizerName = actor.name;
    const ics = kind === 'invited' ? this.buildInviteIcs(row, actor, recipients) : null;

    for (const r of recipients) {
      try {
        const tz = isValidTimezone(r.timezone) ? r.timezone : actor.timezone;
        const when = formatRangeInTimezone(row.start_at, row.end_at, tz, row.is_all_day);
        const message =
          kind === 'invited'
            ? `${organizerName} invited you: ${row.title} · ${when}`
            : kind === 'cancelled'
              ? removedFromInvite
                ? `${organizerName} removed you from: ${row.title}`
                : `${organizerName} cancelled: ${row.title} · ${when}`
              : `${organizerName} updated: ${row.title} · ${when}`;
        await this.notifications.createInAppNotification(
          r.user_id,
          inAppType,
          message,
          kind === 'cancelled' ? '/calendar' : link,
          tenantId,
          { groupKey: `calendar:${row.id}` },
        );
        await this.notifications.sendEmail(
          template,
          r.email,
          {
            organizerName,
            title: row.title,
            when,
            location: row.location,
            meetingUrl: kind === 'cancelled' ? null : row.meeting_url,
            meetingProvider: row.meeting_provider,
            description: row.description,
            linkUrl: kind === 'cancelled' ? '/calendar' : link,
          },
          {
            userId: r.user_id,
            event,
            ...(ics ? { attachments: [{ filename: 'invite.ics', content: ics, contentType: 'text/calendar; method=REQUEST' }] } : {}),
          },
        );
      } catch (err) {
        this.logger.warn(`calendar ${kind} notification to ${r.user_id} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // ─── iCal ───────────────────────────────────────────────────────────────────

  generateIcalToken(userId: string, tenantId: string): string {
    const secret = this.config.get<string>('JWT_SECRET') ?? '';
    return crypto.createHmac('sha256', secret).update(`ical:${userId}:${tenantId}`).digest('hex').slice(0, 40);
  }

  verifyIcalToken(userId: string, tenantId: string, token: string): boolean {
    const expected = this.generateIcalToken(userId, tenantId);
    const a = Buffer.from(expected);
    const b = Buffer.from(token ?? '');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  buildIcalUrl(userId: string, tenantId: string): string {
    const apiUrl = this.config.get<string>('API_URL') ?? 'http://localhost:4000';
    const token = this.generateIcalToken(userId, tenantId);
    return `${apiUrl}/api/v1/calendar/me.ics?uid=${userId}&tid=${tenantId}&token=${token}`;
  }

  /**
   * Resolves a (uid, tid, token) tuple into a subscriber. Members without an
   * employee row (an owner seat) still subscribe — they get holidays + their
   * events. Guests / auditors have no feed.
   */
  async resolveIcalSubscriber(
    uid: string,
    tid: string,
    token: string,
  ): Promise<{ userId: string; tenantId: string; employeeId: string | null }> {
    if (!uid || !tid || !token || !this.verifyIcalToken(uid, tid, token)) {
      throw new UnauthorizedException('Invalid iCal token');
    }
    const [m] = await this.dbAdmin
      .select({ employeeId: memberships.employee_id, role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.user_id, uid), eq(memberships.tenant_id, tid), eq(memberships.status, 'active')))
      .limit(1);
    if (!m || NO_SEAT_ROLES.includes(m.role)) {
      throw new UnauthorizedException('No active membership for this token');
    }
    return { userId: uid, tenantId: tid, employeeId: m.employeeId ?? null };
  }

  /** Rolling 12-month feed: holidays (location-scoped), my leave, my events. */
  async buildIcal(userId: string, tenantId: string, employeeId: string | null): Promise<string> {
    const today = new Date();
    const from = today.toISOString().slice(0, 10);
    const yearOut = new Date(today);
    yearOut.setUTCFullYear(yearOut.getUTCFullYear() + 1);
    const to = yearOut.toISOString().slice(0, 10);
    const fromInstant = new Date(`${from}T00:00:00Z`);
    const toInstant = new Date(`${addDaysISO(to, 1)}T00:00:00Z`);

    // Admin client (no auth context here) — every query carries tenant_id.
    const [tenant] = await this.dbAdmin
      .select({ name: tenants.name, timezone: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const tz = isValidTimezone(tenant?.timezone) ? tenant!.timezone : DEFAULT_TZ;

    let locationId: string | null = null;
    if (employeeId) {
      const [emp] = await this.dbAdmin
        .select({ locationId: employees.location_id })
        .from(employees)
        .where(and(eq(employees.id, employeeId), eq(employees.tenant_id, tenantId)))
        .limit(1);
      locationId = emp?.locationId ?? null;
    }

    const holidayRows = await this.dbAdmin
      .select({ id: holidays.id, date: holidays.holiday_date, name: holidays.name, description: holidays.description })
      .from(holidays)
      .where(
        and(
          eq(holidays.tenant_id, tenantId),
          gte(holidays.holiday_date, from),
          lte(holidays.holiday_date, to),
          locationId ? or(isNull(holidays.location_id), eq(holidays.location_id, locationId)) : isNull(holidays.location_id),
        ),
      );

    const myLeaves = employeeId
      ? await this.dbAdmin
          .select({
            id: leaveRequests.id,
            startDate: leaveRequests.start_date,
            endDate: leaveRequests.end_date,
            status: leaveRequests.status,
            reason: leaveRequests.reason,
            leaveTypeCode: leaveTypes.code,
            leaveTypeName: leaveTypes.name,
          })
          .from(leaveRequests)
          .leftJoin(leaveTypes, and(eq(leaveRequests.leave_type_id, leaveTypes.id), eq(leaveTypes.tenant_id, tenantId)))
          .where(
            and(
              eq(leaveRequests.tenant_id, tenantId),
              eq(leaveRequests.employee_id, employeeId),
              inArray(leaveRequests.status, ['approved', 'pending']),
              lte(leaveRequests.start_date, to),
              gte(leaveRequests.end_date, from),
            ),
          )
      : [];

    const eventRows = await this.dbAdmin
      .select(this.eventColumns())
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.tenant_id, tenantId),
          eq(calendarEvents.event_type, 'company_event'),
          isNull(calendarEvents.cancelled_at),
          lt(calendarEvents.start_at, toInstant),
          gt(calendarEvents.end_at, fromInstant),
          sql`(
            ${calendarEvents.organizer_user_id} = ${userId}
            OR EXISTS (
              SELECT 1 FROM ${calendarEventAttendees} a
              WHERE a.event_id = ${calendarEvents.id}
                AND a.tenant_id = ${tenantId}
                AND a.user_id = ${userId}
                AND a.response <> 'declined'
            )
          )`,
        ),
      )
      .orderBy(asc(calendarEvents.start_at))
      .limit(1000);
    const attendeeMap = eventRows.length
      ? await this.loadAttendeesAdmin(tenantId, eventRows.map((e) => e.id))
      : new Map<string, AttendeeRow[]>();
    const organizerIds = Array.from(new Set(eventRows.map((e) => e.organizer_user_id).filter((x): x is string => !!x)));
    const organizerRows = organizerIds.length
      ? await this.dbAdmin.select({ id: users.id, name: users.full_name, email: users.email }).from(users).where(inArray(users.id, organizerIds))
      : [];
    const organizers = new Map(organizerRows.map((o) => [o.id, o]));

    return this.renderIcal({
      tenantId,
      tenantName: tenant?.name ?? 'Flicks Suite',
      timezone: tz,
      holidays: holidayRows,
      leaves: myLeaves,
      events: eventRows.map((e) => ({
        row: e,
        attendees: attendeeMap.get(e.id) ?? [],
        organizer: e.organizer_user_id ? organizers.get(e.organizer_user_id) ?? null : null,
      })),
    });
  }

  private async loadAttendeesAdmin(tenantId: string, eventIds: string[]): Promise<Map<string, AttendeeRow[]>> {
    const map = new Map<string, AttendeeRow[]>();
    const rows = await this.dbAdmin
      .select({
        event_id: calendarEventAttendees.event_id,
        user_id: calendarEventAttendees.user_id,
        is_optional: calendarEventAttendees.is_optional,
        response: calendarEventAttendees.response,
        name: users.full_name,
        email: users.email,
        avatar_key: users.avatar_key,
        avatar_url: users.avatar_url,
        timezone: users.timezone,
      })
      .from(calendarEventAttendees)
      .innerJoin(users, eq(users.id, calendarEventAttendees.user_id))
      .where(and(eq(calendarEventAttendees.tenant_id, tenantId), inArray(calendarEventAttendees.event_id, eventIds)));
    for (const r of rows) {
      const list = map.get(r.event_id) ?? [];
      list.push(r);
      map.set(r.event_id, list);
    }
    return map;
  }

  /** A single-VEVENT METHOD:REQUEST calendar for the invite email. */
  buildInviteIcs(row: EventRow, organizer: Pick<Viewer, 'name' | 'email'>, attendees: AttendeeRow[]): string {
    const lines: string[] = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Flicks Suite//Calendar//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:REQUEST',
    ];
    lines.push(...this.eventVevent(row, organizer, attendees, row.tenant_id, this.dtstamp(new Date())));
    lines.push('END:VCALENDAR');
    return lines.map((l) => this.fold(l)).join('\r\n') + '\r\n';
  }

  // ─── iCal rendering ────────────────────────────────────────────────────────

  private escapeIcal(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  }

  private icalDate(dateISO: string): string {
    return dateISO.replace(/-/g, '');
  }

  private icalInstant(d: Date): string {
    return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  }

  private dtstamp(now: Date): string {
    return this.icalInstant(now);
  }

  /** RFC 5545 §3.1 — content lines fold at 75 octets (UTF-8 safe). */
  private fold(line: string): string {
    const bytes = Buffer.from(line, 'utf8');
    if (bytes.length <= 75) return line;
    const out: string[] = [];
    let start = 0;
    let first = true;
    while (start < bytes.length) {
      const limit = first ? 75 : 74;
      let end = Math.min(start + limit, bytes.length);
      // Never split inside a multi-byte sequence.
      while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
      out.push((first ? '' : ' ') + bytes.subarray(start, end).toString('utf8'));
      start = end;
      first = false;
    }
    return out.join('\r\n');
  }

  private eventVevent(
    row: EventRow,
    organizer: { name: string; email: string } | null,
    attendees: AttendeeRow[],
    tenantId: string,
    dtstamp: string,
  ): string[] {
    const lines: string[] = ['BEGIN:VEVENT'];
    lines.push(`UID:event-${row.id}@flicks.${tenantId}`);
    lines.push(`DTSTAMP:${dtstamp}`);
    if (row.is_all_day) {
      lines.push(`DTSTART;VALUE=DATE:${this.icalDate(row.start_at.toISOString().slice(0, 10))}`);
      lines.push(`DTEND;VALUE=DATE:${this.icalDate(row.end_at.toISOString().slice(0, 10))}`);
    } else {
      lines.push(`DTSTART:${this.icalInstant(row.start_at)}`);
      lines.push(`DTEND:${this.icalInstant(row.end_at)}`);
    }
    lines.push(`SUMMARY:${this.escapeIcal(row.title)}`);
    const desc = [row.description, row.meeting_url ? `Join: ${row.meeting_url}` : null].filter(Boolean).join('\n\n');
    if (desc) lines.push(`DESCRIPTION:${this.escapeIcal(desc)}`);
    if (row.location) lines.push(`LOCATION:${this.escapeIcal(row.location)}`);
    if (row.meeting_url) lines.push(`URL:${row.meeting_url}`);
    if (organizer) {
      lines.push(`ORGANIZER;CN=${this.escapeIcal(organizer.name)}:mailto:${organizer.email}`);
    }
    for (const a of attendees) {
      const partstat =
        a.response === 'accepted' ? 'ACCEPTED' : a.response === 'declined' ? 'DECLINED' : a.response === 'tentative' ? 'TENTATIVE' : 'NEEDS-ACTION';
      lines.push(
        `ATTENDEE;CN=${this.escapeIcal(a.name)};ROLE=${a.is_optional ? 'OPT-PARTICIPANT' : 'REQ-PARTICIPANT'};PARTSTAT=${partstat}:mailto:${a.email}`,
      );
    }
    lines.push(`SEQUENCE:${Math.max(0, Math.floor((row.updated_at.getTime() - row.created_at.getTime()) / 1000))}`);
    lines.push(row.cancelled_at ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED');
    lines.push(row.is_all_day ? 'TRANSP:TRANSPARENT' : 'TRANSP:OPAQUE');
    lines.push('END:VEVENT');
    return lines;
  }

  private renderIcal(input: {
    tenantId: string;
    tenantName: string;
    timezone: string;
    holidays: Array<{ id: string; date: string; name: string; description: string | null }>;
    leaves: Array<{
      id: string;
      startDate: string;
      endDate: string;
      status: string;
      reason: string | null;
      leaveTypeCode: string | null;
      leaveTypeName: string | null;
    }>;
    events: Array<{ row: EventRow; attendees: AttendeeRow[]; organizer: { name: string; email: string } | null }>;
  }): string {
    const dtstamp = this.dtstamp(new Date());
    const lines: string[] = [];
    lines.push('BEGIN:VCALENDAR');
    lines.push('VERSION:2.0');
    lines.push('PRODID:-//Flicks Suite//Calendar//EN');
    lines.push('CALSCALE:GREGORIAN');
    lines.push('METHOD:PUBLISH');
    lines.push(`X-WR-CALNAME:${this.escapeIcal(input.tenantName)} — My calendar`);
    lines.push(`X-WR-TIMEZONE:${input.timezone}`);

    for (const h of input.holidays) {
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:holiday-${h.id}@flicks.${input.tenantId}`);
      lines.push(`DTSTAMP:${dtstamp}`);
      lines.push(`DTSTART;VALUE=DATE:${this.icalDate(h.date)}`);
      lines.push(`DTEND;VALUE=DATE:${this.icalDate(addDaysISO(h.date, 1))}`);
      lines.push(`SUMMARY:🪔 ${this.escapeIcal(h.name)}`);
      if (h.description) lines.push(`DESCRIPTION:${this.escapeIcal(h.description)}`);
      lines.push('TRANSP:TRANSPARENT');
      lines.push('END:VEVENT');
    }

    for (const l of input.leaves) {
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:leave-${l.id}@flicks.${input.tenantId}`);
      lines.push(`DTSTAMP:${dtstamp}`);
      lines.push(`DTSTART;VALUE=DATE:${this.icalDate(l.startDate)}`);
      lines.push(`DTEND;VALUE=DATE:${this.icalDate(addDaysISO(l.endDate, 1))}`);
      const summary = `${l.leaveTypeCode ?? 'Leave'}${l.status === 'pending' ? ' (pending)' : ''}`;
      lines.push(`SUMMARY:${this.escapeIcal(summary)}`);
      const desc = [l.leaveTypeName ? `Type: ${l.leaveTypeName}` : null, l.reason ? `Reason: ${l.reason}` : null, `Status: ${l.status}`]
        .filter(Boolean)
        .join('\n');
      if (desc) lines.push(`DESCRIPTION:${this.escapeIcal(desc)}`);
      lines.push(l.status === 'approved' ? 'STATUS:CONFIRMED' : 'STATUS:TENTATIVE');
      lines.push('TRANSP:OPAQUE');
      lines.push('END:VEVENT');
    }

    for (const ev of input.events) {
      lines.push(...this.eventVevent(ev.row, ev.organizer, ev.attendees, input.tenantId, dtstamp));
    }

    lines.push('END:VCALENDAR');
    return lines.map((l) => this.fold(l)).join('\r\n') + '\r\n';
  }
}

// Re-exported for the controller / spec (keeps the old import name working).
export type { CalendarFeedItem as CalendarEvent };
