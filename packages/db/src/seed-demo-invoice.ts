/**
 * Demo invoice seed for @flicks/db
 *
 * Gives the Invoicing module a ready-to-open invoice so the "PDF" download
 * button (and the hosted /inv/:token page) has a real target right after
 * `pnpm setup:demo`. Without this, the Invoices screen is empty because
 * setup-demo.sh only seeds HRMS data.
 *
 * Seeds into the Demo Co tenant (11111111-…-111111111111) created by
 * scripts/setup-demo.sh — override with DEMO_TENANT_ID. Idempotent: fixed UUIDs
 * + ON CONFLICT (and a delete-then-insert for line items, which have no natural
 * unique key).
 *
 * Usage: pnpm db:seed:invoice
 *   Auto-loads apps/api/.env, so you do NOT need to `set -a; source .env` first.
 *   Connection: DATABASE_DIRECT_URL → DATABASE_SERVICE_ROLE_URL → DATABASE_URL
 *   (a superuser/BYPASSRLS URL is preferred so the cross-tenant insert isn't
 *   blocked by RLS).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';

/**
 * Minimal .env loader (no dotenv dependency) so `pnpm db:seed:invoice` works
 * without `set -a; source apps/api/.env` first. Already-set process env wins.
 */
function loadEnvFile(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return; // file absent — rely on the real environment
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

// Load apps/api/.env regardless of where pnpm sets cwd (packages/db).
loadEnvFile(resolve(__dirname, '../../../apps/api/.env'));

const url =
  process.env['DATABASE_DIRECT_URL'] ??
  process.env['DATABASE_SERVICE_ROLE_URL'] ??
  process.env['DATABASE_URL'];

if (!url) {
  console.error(
    'ERROR: set DATABASE_DIRECT_URL, DATABASE_SERVICE_ROLE_URL, or DATABASE_URL (apps/api/.env).',
  );
  process.exit(1);
}

const TENANT =
  process.env['DEMO_TENANT_ID'] ?? '11111111-1111-1111-1111-111111111111';
const OWNER_EMAIL = process.env['DEMO_OWNER_EMAIL'] ?? 'niranjan@demo.co';
const CUSTOMER_ID = 'de300000-0000-4000-8000-000000000001';
const INVOICE_ID = 'de100000-0000-4000-8000-000000000001';

const sql = postgres(url, { max: 1 });

async function main() {
  const tenant = await sql<{ id: string; name: string }[]>`
    SELECT id, name FROM tenants WHERE id = ${TENANT}
  `;
  if (tenant.length === 0) {
    console.error(
      `Demo tenant ${TENANT} not found. Run \`pnpm setup:demo\` first, or pass DEMO_TENANT_ID=<an existing tenant>.`,
    );
    await sql.end();
    process.exit(1);
  }

  // created_by is a nullable FK to users — attach the Demo Co owner when present
  // (so the row looks authored), otherwise leave null.
  const owner = await sql<{ id: string }[]>`
    SELECT u.id FROM users u WHERE u.email = ${OWNER_EMAIL} LIMIT 1
  `;
  const createdBy = owner[0]?.id ?? null;

  await sql`
    INSERT INTO customers (
      id, tenant_id, customer_code, display_name, legal_name, email,
      country_code, state_code, is_gst_registered, gstin, default_currency, status,
      billing_address_line1, billing_city, billing_state, billing_postal_code, billing_country
    ) VALUES (
      ${CUSTOMER_ID}, ${TENANT}, 'DEMO-CUST-01', 'Acme Test Pvt Ltd', 'Acme Test Private Limited', 'ap@acme.test',
      'IN', '29', true, '29ABCDE1234F1Z5', 'INR', 'active',
      '4th Floor, Tech Park, Outer Ring Road', 'Bengaluru', 'Karnataka', '560103', 'India'
    )
    ON CONFLICT (id) DO NOTHING
  `;

  // Inter-state supply (seller POS 27 / customer state 29) → IGST @ 18%.
  await sql`
    INSERT INTO invoices (
      id, tenant_id, customer_id, invoice_number, document_type, status,
      invoice_date, due_date, fy_label, currency,
      subtotal, taxable_amount, igst_amount, total_amount, net_receivable, amount_outstanding,
      place_of_supply, tax_treatment, notes, created_by
    ) VALUES (
      ${INVOICE_ID}, ${TENANT}, ${CUSTOMER_ID}, 'INV-DEMO-0001', 'INVOICE', 'SENT',
      CURRENT_DATE - 5, CURRENT_DATE + 10, '2026-27', 'INR',
      15000, 15000, 2700, 17700, 17700, 17700,
      '27', 'inter_state', 'Demo invoice seeded for PDF-download testing.', ${createdBy}
    )
    ON CONFLICT (id) DO NOTHING
  `;

  // Line items have no natural unique key — replace them so re-runs stay clean.
  await sql`DELETE FROM invoice_line_items WHERE invoice_id = ${INVOICE_ID}`;
  await sql`
    INSERT INTO invoice_line_items (
      tenant_id, invoice_id, line_number, item_name, description, hsn_sac_code,
      quantity, unit, rate, gst_rate, line_amount, taxable_amount, igst_amount, line_total
    ) VALUES
      (${TENANT}, ${INVOICE_ID}, 1, 'Consulting — platform build', 'Senior engineering retainer', '998314',
       10, 'hrs', 1000, 18, 10000, 10000, 1800, 11800),
      (${TENANT}, ${INVOICE_ID}, 2, 'Design system', 'Component library + design tokens', '998314',
       2, 'pkg', 2500, 18, 5000, 5000, 900, 5900)
  `;

  const [inv] = await sql<
    { invoice_number: string; status: string; currency: string; total_amount: string }[]
  >`
    SELECT invoice_number, status, currency, total_amount FROM invoices WHERE id = ${INVOICE_ID}
  `;
  console.log(`✓ Demo invoice ready in tenant "${tenant[0]!.name}":`, inv);
  console.log(`  created_by: ${createdBy ?? '(none — owner user not found)'}`);
  console.log('  → Log in as the Demo Co owner, open Invoicing → Invoices, click "PDF".');

  await sql.end();
}

main().catch(async (err) => {
  console.error('Demo invoice seed failed:', err);
  await sql.end().catch(() => undefined);
  process.exit(1);
});
