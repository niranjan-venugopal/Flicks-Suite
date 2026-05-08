/**
 * Seed script for @flicks/db
 *
 * Seeds:
 *  - 11 Indian leave types (CL, SL, EL, ML, PL, BL, CO, LOP, MR, RH, WFH)
 *  - 2026 Indian national holidays
 *  - Regional holidays for Karnataka, Maharashtra, Tamil Nadu, Delhi, Telangana
 *
 * Usage: pnpm seed  (requires DATABASE_SERVICE_ROLE_URL or DATABASE_URL)
 *
 * This seed is idempotent — re-running will not duplicate records because we
 * upsert on tenant_id + code or holiday_date + name.
 */

import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';
import * as schema from './schema/index.js';

// ─── DB connection ─────────────────────────────────────────────────────────────

const connectionUrl =
  process.env['DATABASE_SERVICE_ROLE_URL'] ?? process.env['DATABASE_URL'];

if (!connectionUrl) {
  console.error(
    'ERROR: DATABASE_SERVICE_ROLE_URL or DATABASE_URL must be set.',
  );
  process.exit(1);
}

const sql = postgres(connectionUrl, { max: 1 });
const db = drizzle(sql, { schema });

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SEED_TENANT_ID =
  process.env['SEED_TENANT_ID'] ?? '00000000-0000-0000-0000-000000000001';

// ─── Leave Types ──────────────────────────────────────────────────────────────

interface LeaveTypeSeed {
  code: string;
  name: string;
  description: string;
  default_quota_days: number;
  is_paid: boolean;
  is_lop: boolean;
  accrual_method: schema.NewLeaveType['accrual_method'];
  carry_forward_allowed: boolean;
  max_carry_forward_days: number;
  allow_half_day: boolean;
  requires_attachment: boolean;
  attachment_after_days: number;
  applicable_genders: string[] | null;
  applicable_employment_types: string[] | null;
  min_tenure_days: number;
  display_order: number;
  color: string;
}

const leaveTypesData: LeaveTypeSeed[] = [
  {
    code: 'CL',
    name: 'Casual Leave',
    description:
      'For unforeseen personal exigencies. Short-notice, discretionary leave.',
    default_quota_days: 12,
    is_paid: true,
    is_lop: false,
    accrual_method: 'monthly',
    carry_forward_allowed: false,
    max_carry_forward_days: 0,
    allow_half_day: true,
    requires_attachment: false,
    attachment_after_days: 0,
    applicable_genders: null,
    applicable_employment_types: null,
    min_tenure_days: 0,
    display_order: 1,
    color: '#6366f1',
  },
  {
    code: 'SL',
    name: 'Sick Leave',
    description:
      'For medical illness or injury. Medical certificate required after 3 consecutive days.',
    default_quota_days: 12,
    is_paid: true,
    is_lop: false,
    accrual_method: 'monthly',
    carry_forward_allowed: false,
    max_carry_forward_days: 0,
    allow_half_day: true,
    requires_attachment: true,
    attachment_after_days: 3,
    applicable_genders: null,
    applicable_employment_types: null,
    min_tenure_days: 0,
    display_order: 2,
    color: '#f59e0b',
  },
  {
    code: 'EL',
    name: 'Earned Leave',
    description:
      'Accrued leave based on service. Also known as Privileged Leave (PL). Carry forward permitted up to 30 days.',
    default_quota_days: 15,
    is_paid: true,
    is_lop: false,
    accrual_method: 'monthly',
    carry_forward_allowed: true,
    max_carry_forward_days: 30,
    allow_half_day: true,
    requires_attachment: false,
    attachment_after_days: 0,
    applicable_genders: null,
    applicable_employment_types: null,
    min_tenure_days: 0,
    display_order: 3,
    color: '#10b981',
  },
  {
    code: 'ML',
    name: 'Maternity Leave',
    description:
      'Paid leave for biological or adoptive mothers as per Maternity Benefit Act 1961 (26 weeks for first two children).',
    default_quota_days: 182,
    is_paid: true,
    is_lop: false,
    accrual_method: 'none',
    carry_forward_allowed: false,
    max_carry_forward_days: 0,
    allow_half_day: false,
    requires_attachment: true,
    attachment_after_days: 0,
    applicable_genders: ['female'],
    applicable_employment_types: null,
    min_tenure_days: 80,
    display_order: 4,
    color: '#ec4899',
  },
  {
    code: 'PL',
    name: 'Paternity Leave',
    description:
      'Paid leave for new fathers. 15 days within 6 months of birth/adoption.',
    default_quota_days: 15,
    is_paid: true,
    is_lop: false,
    accrual_method: 'none',
    carry_forward_allowed: false,
    max_carry_forward_days: 0,
    allow_half_day: false,
    requires_attachment: true,
    attachment_after_days: 0,
    applicable_genders: ['male'],
    applicable_employment_types: null,
    min_tenure_days: 0,
    display_order: 5,
    color: '#3b82f6',
  },
  {
    code: 'BL',
    name: 'Bereavement Leave',
    description:
      'Paid leave on death of immediate family member (spouse, children, parents, siblings).',
    default_quota_days: 5,
    is_paid: true,
    is_lop: false,
    accrual_method: 'none',
    carry_forward_allowed: false,
    max_carry_forward_days: 0,
    allow_half_day: false,
    requires_attachment: true,
    attachment_after_days: 0,
    applicable_genders: null,
    applicable_employment_types: null,
    min_tenure_days: 0,
    display_order: 6,
    color: '#64748b',
  },
  {
    code: 'CO',
    name: 'Compensatory Off',
    description:
      'Comp off earned by working on holidays or weekends. Must be consumed within 90 days.',
    default_quota_days: 0,
    is_paid: true,
    is_lop: false,
    accrual_method: 'none',
    carry_forward_allowed: false,
    max_carry_forward_days: 0,
    allow_half_day: true,
    requires_attachment: false,
    attachment_after_days: 0,
    applicable_genders: null,
    applicable_employment_types: null,
    min_tenure_days: 0,
    display_order: 7,
    color: '#8b5cf6',
  },
  {
    code: 'LOP',
    name: 'Loss of Pay',
    description:
      'Unpaid leave when employee has exhausted all paid leave balances.',
    default_quota_days: 0,
    is_paid: false,
    is_lop: true,
    accrual_method: 'none',
    carry_forward_allowed: false,
    max_carry_forward_days: 0,
    allow_half_day: true,
    requires_attachment: false,
    attachment_after_days: 0,
    applicable_genders: null,
    applicable_employment_types: null,
    min_tenure_days: 0,
    display_order: 8,
    color: '#ef4444',
  },
  {
    code: 'MR',
    name: 'Marriage Leave',
    description:
      "Paid leave for employee's own marriage. 3 working days within 15 days of wedding.",
    default_quota_days: 3,
    is_paid: true,
    is_lop: false,
    accrual_method: 'none',
    carry_forward_allowed: false,
    max_carry_forward_days: 0,
    allow_half_day: false,
    requires_attachment: true,
    attachment_after_days: 0,
    applicable_genders: null,
    applicable_employment_types: null,
    min_tenure_days: 0,
    display_order: 9,
    color: '#f97316',
  },
  {
    code: 'RH',
    name: 'Restricted Holiday',
    description:
      'Optional holidays from approved list. Employees may choose up to 2 per year.',
    default_quota_days: 2,
    is_paid: true,
    is_lop: false,
    accrual_method: 'annually',
    carry_forward_allowed: false,
    max_carry_forward_days: 0,
    allow_half_day: false,
    requires_attachment: false,
    attachment_after_days: 0,
    applicable_genders: null,
    applicable_employment_types: null,
    min_tenure_days: 0,
    display_order: 10,
    color: '#06b6d4',
  },
  {
    code: 'WFH',
    name: 'Work From Home',
    description:
      'Formal WFH request for tracking purposes. Does not deduct from leave balance.',
    default_quota_days: 0,
    is_paid: true,
    is_lop: false,
    accrual_method: 'none',
    carry_forward_allowed: false,
    max_carry_forward_days: 0,
    allow_half_day: true,
    requires_attachment: false,
    attachment_after_days: 0,
    applicable_genders: null,
    applicable_employment_types: null,
    min_tenure_days: 0,
    display_order: 11,
    color: '#84cc16',
  },
];

// ─── Holiday data ─────────────────────────────────────────────────────────────

interface HolidaySeed {
  holiday_date: string; // YYYY-MM-DD
  name: string;
  type: schema.NewHoliday['type'];
  description?: string;
  location_name?: string; // for regional holidays
  state_code?: string; // for regional identification
}

const nationalHolidays2026: HolidaySeed[] = [
  {
    holiday_date: '2026-01-26',
    name: 'Republic Day',
    type: 'national',
    description:
      'Commemorates the date on which the Constitution of India came into effect on 26 January 1950.',
  },
  {
    holiday_date: '2026-08-15',
    name: 'Independence Day',
    type: 'national',
    description:
      "India's Independence Day commemorating the nation's independence from British rule on 15 August 1947.",
  },
  {
    holiday_date: '2026-10-02',
    name: 'Gandhi Jayanti',
    type: 'national',
    description:
      "Birthday of Mahatma Gandhi, the Father of the Nation. One of India's three national holidays.",
  },
];

// Regional holidays by state for 2026
const regionalHolidays2026: HolidaySeed[] = [
  // ── Karnataka ──
  {
    holiday_date: '2026-01-15',
    name: 'Sankranti / Makara Sankranti',
    type: 'regional',
    description: 'Harvest festival marking the sun\'s transition into Capricorn.',
    state_code: 'KA',
  },
  {
    holiday_date: '2026-03-30',
    name: 'Ugadi',
    type: 'regional',
    description: 'Kannada New Year.',
    state_code: 'KA',
  },
  {
    holiday_date: '2026-04-14',
    name: 'Dr. B.R. Ambedkar Jayanti',
    type: 'regional',
    description: 'Birthday of Dr. B.R. Ambedkar, architect of the Indian Constitution.',
    state_code: 'KA',
  },
  {
    holiday_date: '2026-10-17',
    name: 'Kannada Rajyotsava',
    type: 'regional',
    description: 'Karnataka Formation Day — celebrates the unification of Kannada-speaking regions.',
    state_code: 'KA',
  },
  {
    holiday_date: '2026-10-02',
    name: 'Ayudha Puja',
    type: 'regional',
    description: 'Day of worship of tools and implements, celebrated during Navratri.',
    state_code: 'KA',
  },
  {
    holiday_date: '2026-10-03',
    name: 'Vijayadashami (Dasara)',
    type: 'regional',
    description: 'Mysore Dasara — major festival in Karnataka celebrating the victory of good over evil.',
    state_code: 'KA',
  },

  // ── Maharashtra ──
  {
    holiday_date: '2026-01-15',
    name: 'Makar Sankranti',
    type: 'regional',
    description: 'Harvest festival celebrated across Maharashtra.',
    state_code: 'MH',
  },
  {
    holiday_date: '2026-03-30',
    name: 'Gudi Padwa',
    type: 'regional',
    description: 'Marathi New Year.',
    state_code: 'MH',
  },
  {
    holiday_date: '2026-04-14',
    name: 'Dr. Babasaheb Ambedkar Jayanti',
    type: 'regional',
    description: 'Birthday of Dr. B.R. Ambedkar, celebrated with great fervour in Maharashtra.',
    state_code: 'MH',
  },
  {
    holiday_date: '2026-05-01',
    name: 'Maharashtra Day',
    type: 'regional',
    description: 'Maharashtra Formation Day — celebrates the establishment of Maharashtra state.',
    state_code: 'MH',
  },
  {
    holiday_date: '2026-08-27',
    name: 'Ganesh Chaturthi',
    type: 'regional',
    description: 'Birthday of Lord Ganesha, the most widely celebrated festival in Maharashtra.',
    state_code: 'MH',
  },
  {
    holiday_date: '2026-11-14',
    name: 'Diwali (Lakshmi Puja)',
    type: 'regional',
    description: 'Main day of Diwali celebration — festival of lights.',
    state_code: 'MH',
  },

  // ── Tamil Nadu ──
  {
    holiday_date: '2026-01-14',
    name: 'Pongal',
    type: 'regional',
    description: 'Tamil harvest festival, multi-day celebration. First day: Bhogi Pongal.',
    state_code: 'TN',
  },
  {
    holiday_date: '2026-01-15',
    name: 'Thai Pongal',
    type: 'regional',
    description: 'Main Pongal day — thanksgiving to the Sun God for a bountiful harvest.',
    state_code: 'TN',
  },
  {
    holiday_date: '2026-04-14',
    name: 'Tamil New Year (Puthandu)',
    type: 'regional',
    description: 'Tamil New Year — first day of the Tamil month Chithirai.',
    state_code: 'TN',
  },
  {
    holiday_date: '2026-04-14',
    name: 'Dr. Ambedkar Birthday',
    type: 'regional',
    description: 'Birthday of Dr. B.R. Ambedkar.',
    state_code: 'TN',
  },
  {
    holiday_date: '2026-08-01',
    name: 'Aadi Perukku',
    type: 'regional',
    description: 'Tamil festival celebrating the rising of the Cauvery river waters.',
    state_code: 'TN',
  },
  {
    holiday_date: '2026-09-02',
    name: 'Vinayaka Chaturthi',
    type: 'regional',
    description: 'Birthday of Lord Ganesha.',
    state_code: 'TN',
  },

  // ── Delhi (NCT) ──
  {
    holiday_date: '2026-01-15',
    name: 'Makar Sankranti',
    type: 'regional',
    description: 'Harvest festival celebrated in North India.',
    state_code: 'DL',
  },
  {
    holiday_date: '2026-03-29',
    name: 'Holi',
    type: 'regional',
    description: 'Festival of colours — second day (Dhulandi).',
    state_code: 'DL',
  },
  {
    holiday_date: '2026-04-14',
    name: 'Dr. Ambedkar Jayanti',
    type: 'regional',
    description: 'Birthday of Dr. B.R. Ambedkar.',
    state_code: 'DL',
  },
  {
    holiday_date: '2026-11-13',
    name: 'Diwali',
    type: 'regional',
    description: 'Festival of lights — main Diwali day.',
    state_code: 'DL',
  },
  {
    holiday_date: '2026-11-05',
    name: 'Guru Nanak Jayanti',
    type: 'regional',
    description: 'Birthday of Guru Nanak Dev Ji, founder of Sikhism.',
    state_code: 'DL',
  },
  {
    holiday_date: '2026-12-25',
    name: 'Christmas Day',
    type: 'regional',
    description: 'Christian festival celebrating the birth of Jesus Christ.',
    state_code: 'DL',
  },

  // ── Telangana ──
  {
    holiday_date: '2026-01-15',
    name: 'Sankranti',
    type: 'regional',
    description: 'Harvest festival marking the solar transition.',
    state_code: 'TS',
  },
  {
    holiday_date: '2026-03-30',
    name: 'Ugadi',
    type: 'regional',
    description: 'Telugu New Year.',
    state_code: 'TS',
  },
  {
    holiday_date: '2026-06-02',
    name: 'Telangana Formation Day',
    type: 'regional',
    description: 'Celebrates the formation of Telangana state on 2 June 2014.',
    state_code: 'TS',
  },
  {
    holiday_date: '2026-09-02',
    name: 'Vinayaka Chaturthi',
    type: 'regional',
    description: 'Birthday of Lord Ganesha, celebrated widely in Telangana.',
    state_code: 'TS',
  },
  {
    holiday_date: '2026-10-02',
    name: 'Bathukamma',
    type: 'regional',
    description: 'Telangana\'s floral festival celebrating womanhood and fertility.',
    state_code: 'TS',
  },
  {
    holiday_date: '2026-10-03',
    name: 'Dasara',
    type: 'regional',
    description: 'Vijayadashami — celebrating the victory of good over evil.',
    state_code: 'TS',
  },
];

// ─── Seed functions ────────────────────────────────────────────────────────────

async function seedLeaveTypes(tenantId: string): Promise<void> {
  console.log(`\nSeeding leave types for tenant ${tenantId}...`);

  for (const lt of leaveTypesData) {
    // Check if already exists
    const existing = await db
      .select({ id: schema.leaveTypes.id })
      .from(schema.leaveTypes)
      .where(
        and(
          eq(schema.leaveTypes.tenant_id, tenantId),
          eq(schema.leaveTypes.code, lt.code),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      console.log(`  [SKIP] Leave type ${lt.code} already exists.`);
      continue;
    }

    await db.insert(schema.leaveTypes).values({
      tenant_id: tenantId,
      code: lt.code,
      name: lt.name,
      description: lt.description,
      default_quota_days: lt.default_quota_days,
      is_paid: lt.is_paid,
      is_lop: lt.is_lop,
      accrual_method: lt.accrual_method,
      carry_forward_allowed: lt.carry_forward_allowed,
      max_carry_forward_days: lt.max_carry_forward_days,
      allow_half_day: lt.allow_half_day,
      requires_attachment: lt.requires_attachment,
      attachment_after_days: lt.attachment_after_days,
      applicable_genders: lt.applicable_genders ?? null,
      applicable_employment_types: lt.applicable_employment_types ?? null,
      min_tenure_days: lt.min_tenure_days,
      display_order: lt.display_order,
      color: lt.color,
      prorate_for_new_joiners: true,
      prorate_basis: 'months_remaining_in_year',
      count_weekend_in_between: false,
      is_active: true,
    });

    console.log(`  [OK] Created leave type: ${lt.code} — ${lt.name}`);
  }
}

async function seedHolidays(tenantId: string): Promise<void> {
  console.log(`\nSeeding national holidays (2026) for tenant ${tenantId}...`);

  for (const h of nationalHolidays2026) {
    const existing = await db
      .select({ id: schema.holidays.id })
      .from(schema.holidays)
      .where(
        and(
          eq(schema.holidays.tenant_id, tenantId),
          eq(schema.holidays.holiday_date, h.holiday_date),
          eq(schema.holidays.name, h.name),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      console.log(`  [SKIP] Holiday "${h.name}" (${h.holiday_date}) already exists.`);
      continue;
    }

    await db.insert(schema.holidays).values({
      tenant_id: tenantId,
      holiday_date: h.holiday_date,
      name: h.name,
      type: h.type,
      description: h.description ?? null,
      is_recurring: true,
    });

    console.log(`  [OK] Created national holiday: ${h.name} (${h.holiday_date})`);
  }

  console.log(`\nSeeding regional holidays (2026) for tenant ${tenantId}...`);

  for (const h of regionalHolidays2026) {
    const existing = await db
      .select({ id: schema.holidays.id })
      .from(schema.holidays)
      .where(
        and(
          eq(schema.holidays.tenant_id, tenantId),
          eq(schema.holidays.holiday_date, h.holiday_date),
          eq(schema.holidays.name, h.name),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      console.log(
        `  [SKIP] Regional holiday "${h.name}" (${h.holiday_date}, ${h.state_code}) already exists.`,
      );
      continue;
    }

    await db.insert(schema.holidays).values({
      tenant_id: tenantId,
      holiday_date: h.holiday_date,
      name: h.name,
      type: h.type,
      description: `[${h.state_code}] ${h.description ?? ''}`.trim(),
      is_recurring: false,
    });

    console.log(
      `  [OK] Created regional holiday: ${h.name} (${h.holiday_date}, ${h.state_code})`,
    );
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const tenantId = SEED_TENANT_ID;

  console.log('='.repeat(60));
  console.log('Flicks Suite — Database Seed');
  console.log('='.repeat(60));
  console.log(`Target tenant ID: ${tenantId}`);
  console.log(
    'Note: Set SEED_TENANT_ID env var to target a specific tenant.\n',
  );

  // Verify tenant exists (if we are targeting a real tenant)
  if (tenantId !== '00000000-0000-0000-0000-000000000001') {
    const tenant = await db
      .select({ id: schema.tenants.id, name: schema.tenants.name })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, tenantId))
      .limit(1);

    if (tenant.length === 0) {
      console.error(`ERROR: Tenant ${tenantId} not found in database.`);
      process.exit(1);
    }

    console.log(`Found tenant: ${tenant[0]?.name}`);
  }

  await seedLeaveTypes(tenantId);
  await seedHolidays(tenantId);

  console.log('\n' + '='.repeat(60));
  console.log('Seed complete!');
  console.log('='.repeat(60));

  await sql.end();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
