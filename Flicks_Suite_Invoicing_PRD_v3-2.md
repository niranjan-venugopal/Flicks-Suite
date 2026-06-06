# Flicks Suite — Invoicing Module · Development PRD (v3, self-contained)

> **This document is self-contained.** It requires **no other PRD**. It carries the platform foundation, the complete data model, the API surface, the business rules, and every v3 feature needed to build the Invoicing module. Pair it only with the **approved design files** (the UI/visual source of truth).
>
> **Assumption:** the **platform foundation** in §1 (auth, `tenants`, `users`, `memberships`, RLS infra) may already exist in the codebase. If it does, reuse it; if not, build §1 first. Everything else here is the Invoicing module to build.
>
> **What v3 establishes (vs. earlier internal drafts):** Invoicing and Payroll are **separate top-level modules** (no "Finance" parent); navigation stays on the **existing v1 two-level sidebar + a company switcher**; settings are **per-module** plus a **shared `Organization → Financial details`** block; there is a new **Auditor** role with **multi-company** access; **company bank details** auto-populate invoices with **conditional SWIFT/IFSC**; **invoice numbering** is editable with GST guardrails; the invoice **editor is single-column**; **preview** and the **public invoice page** are full-page, chrome-less, and share one renderer.

---

## Table of contents
1. Platform foundation (stack, auth, multi-tenant RLS, identity tables)
2. Module scope & navigation
3. Roles & access control (incl. Auditor + multi-company)
4. Data model (complete — existing + v3-new tables, with RLS)
5. API surface
6. Business rules (GST, TDS, pricing, lifecycle, numbering, dunning, reminders, FX, GSTR-1)
7. Settings (per-module + shared Organization → Financial details)
8. Company bank details + conditional SWIFT/IFSC
9. Invoice editor, preview & hosted public view
10. FAM (platform admin)
11. Setup wizard
12. Migrations
13. Non-goals · success metrics · open questions · build order

---

## 1. Platform foundation

**Stack (locked):** Next.js 15 (frontend) · NestJS 11 (backend) · Drizzle ORM · **PostgreSQL 17 on Supabase** (Mumbai) · Razorpay (payments) · Resend (email) · Cloudflare R2 (file storage) · Upstash Redis + BullMQ (cache/queues/scheduled jobs) · Vercel (frontend) + Railway (backend) · Turborepo + pnpm monorepo · shadcn/ui components.

**Auth:** custom **Passport.js + JWT + email-OTP** (Resend delivers OTP). The JWT carries `tenant_id` and `user_id` (and the user's role for the active tenant). There is **no Clerk / no Supabase-Auth dependency** — auth is owned.

**Multi-tenancy = shared schema + Row-Level Security (RLS).** A single Postgres schema; every tenant-scoped table has a `tenant_id` column and a uniform RLS policy. There is **no schema-per-tenant**.

**RLS pattern — apply to EVERY tenant-scoped table:**
```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE  ROW LEVEL SECURITY;   -- applies even to table owners
CREATE POLICY tenant_isolation_<t> ON <t>
  FOR ALL
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

**RLS enforcement at request time:** `TenantContextMiddleware` reads `tenant_id`/`user_id` from the JWT into `nestjs-cls`; the DB layer opens a transaction and sets the session vars before queries run:
```typescript
// db.runQuery(): set tenant + user context for RLS, per transaction
await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
await tx.execute(sql`SELECT set_config('app.user_id',  ${userId},  true)`); // needed for the company switcher (§3.5)
```

**Table conventions (all new tables):** `id UUID PRIMARY KEY DEFAULT gen_random_uuid()` (use the project's UUID-v7 helper if present); `tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`; `created_at`/`updated_at TIMESTAMPTZ DEFAULT now()`; `created_by`/`updated_by UUID REFERENCES users(id)`; `deleted_at TIMESTAMPTZ` soft-delete; **composite indexes leading with `tenant_id`**.

**FAM (Specflicks platform admin) cross-tenant access:** a dedicated Postgres role `flicks_service_role` with **`BYPASSRLS`**, used **only** inside the FAM module's service layer — never exposed to tenant-facing controllers.
```sql
CREATE ROLE flicks_service_role WITH LOGIN PASSWORD '...';
GRANT BYPASSRLS TO flicks_service_role;
GRANT USAGE ON SCHEMA public TO flicks_service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO flicks_service_role;
```

**Cross-tenant isolation test suite (CI-required):** a suite creates two tenants, seeds distinct data, and asserts no query from tenant A returns tenant B's rows (SELECT/INSERT/UPDATE/DELETE/JOIN/subquery). It blocks any failing PR. **Every new table in this doc must be added to it**, plus an auditor-in-two-companies test (§3, §8 security notes).

**API:** all endpoints under `/api/v1/...`, JWT bearer, response envelope `{ data: T, meta?: {...}, errors?: [...] }`.

**Foundation tables (build on these — DDL inlined so no other doc is needed):**
```sql
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  slug VARCHAR(80) UNIQUE NOT NULL,            -- subdomain, e.g. specflicks.flicks.app
  legal_name VARCHAR(255),
  gstin VARCHAR(15),                            -- validated 27ABCDE1234F1Z5
  pan VARCHAR(10),
  cin VARCHAR(21),
  industry VARCHAR(80),
  size_band VARCHAR(20),
  country_code CHAR(2) DEFAULT 'IN',
  state_code CHAR(2),
  city VARCHAR(100),
  address_line1 VARCHAR(255), address_line2 VARCHAR(255), postal_code VARCHAR(15),
  timezone VARCHAR(60) DEFAULT 'Asia/Kolkata',
  currency CHAR(3) DEFAULT 'INR',
  fiscal_year_start_month SMALLINT DEFAULT 4,   -- April
  date_format VARCHAR(20) DEFAULT 'DD/MM/YYYY',
  logo_url TEXT,
  brand_color VARCHAR(7),
  status VARCHAR(20) DEFAULT 'trialing',        -- trialing|active|past_due|canceled|suspended
  trial_ends_at TIMESTAMPTZ, verified_at TIMESTAMPTZ, verified_by_user_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), deleted_at TIMESTAMPTZ
);
CREATE INDEX idx_tenants_slug ON tenants(slug) WHERE deleted_at IS NULL;

CREATE TABLE users (                            -- GLOBAL identity (one user → many tenants)
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email CITEXT UNIQUE NOT NULL,
  email_verified_at TIMESTAMPTZ,
  full_name VARCHAR(200), avatar_url TEXT, phone VARCHAR(20), phone_verified_at TIMESTAMPTZ,
  locale VARCHAR(10) DEFAULT 'en-IN', timezone VARCHAR(60),
  is_platform_admin BOOLEAN DEFAULT FALSE,      -- Specflicks team = FAM access
  status VARCHAR(20) DEFAULT 'active',
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE memberships (                       -- M2M users↔tenants; role per tenant
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  employee_id UUID,
  role VARCHAR(40) NOT NULL,                     -- super_admin|admin|manager|finance|employee|auditor (auditor is NEW, §3)
  status VARCHAR(20) DEFAULT 'active',           -- pending|active|suspended
  invited_by UUID REFERENCES users(id), invited_at TIMESTAMPTZ, accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX idx_memberships_user ON memberships(user_id);
CREATE INDEX idx_memberships_tenant ON memberships(tenant_id);
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_memberships ON memberships
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
          WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
```
> Note: `tenants` already holds **legal name, address, GSTIN, PAN, and fiscal year** — the shared "Financial details" (§7/§8) reuses these; only **bank accounts** need new tables.

---

## 2. Module scope & navigation

**Two separate top-level modules.** Invoicing ships now; **Payroll** is a separate future module (Phase 2) — **not** a child of Invoicing, and there is **no "Finance" parent**. Expenses is a later separate module too. The Auditor sees only the financial modules they're granted, which together form their finance workspace (achieved via grant-driven nav, not a Finance parent).

**Navigation shell = the existing v1 two-level collapsible sidebar + a company switcher.** Do **not** build an icon-rail / context-panel / workbench-tabs shell (deferred; see §13).
1. **One left sidebar, two levels (top-level modules → sub-items), collapsible.** Top-level items: `Home · People · Time · Sales · Invoicing · Reports · Settings` (Payroll appears as its own top-level item later). The active module **expands in place** to show its sub-items. Which top-level items appear is governed by **role + per-module grants + FAM module toggles** (§10). An Auditor sees a minimal sidebar of only their granted financial modules + Home.
2. **Company switcher** at the **top of the sidebar** (under the logo): a workspace dropdown that switches the **active company** for users in more than one company (Auditors; Owners who own multiple companies). Single-company users just see their company name. This is the Slack/Notion pattern — it does **not** require an icon rail.

**Invoicing sidebar items (the expanded "Invoicing" section):**
```
INVOICING
├─ Overview            ← dashboard KPIs + pending actions
├─ Invoices
├─ Quotes / Estimates
├─ Recurring / Subscriptions
├─ Customers
├─ Items / Catalogue
├─ Credit & Debit Notes
├─ Payments
├─ Reports            ← GSTR-1 export, TDS receivable, aging, subscription metrics
└─ Settings           ← Invoicing-only settings (§7.1)
```
Items render **only** where the role has the matching grant.

**Routes:**
| Area | Route |
|---|---|
| Invoicing module | `/app/invoicing/*` |
| Invoice editor (single-column) | `/app/invoicing/new`, `/app/invoicing/:id/edit` |
| Full-page preview (auth, chrome-less) | `/app/invoicing/:id/preview` |
| Invoicing settings | `/app/invoicing/settings/*` |
| Shared Organization → Financial details | `/app/settings/organization` (Financial details section) |
| Hosted public invoice page (no app chrome) | `{tenant-slug}.flickssuite.com/inv/{token}` |
| Public quote page | `{tenant-slug}.flickssuite.com/q/{token}` |
| Payroll (Phase 2, separate module) | `/app/payroll/*` |

---

## 3. Roles & access control (RBAC)

### 3.1 Roles
| Role | Plane | One-line |
|---|---|---|
| **Owner** (`super_admin`) | Tenant | Full control of one company incl. billing & permissions. |
| **Admin** | Tenant | Full operational control; no billing/permissions/owner-transfer. |
| **Finance** | Tenant | Internal finance operator; single company. |
| **Auditor** (NEW) | Tenant, cross-tenant capable | Finance-scoped; granted per-module at invite; **multi-company** under one login; **non-billable seat**. Fits external CAs and internal finance reviewers. |
| **Manager** | Tenant | No invoicing by default; optional read-only invoices. |
| **Employee** | Tenant | No invoicing by default; optional "own invoices only". |
| **FAM** | Platform | Specflicks platform admin (`is_platform_admin = true`); never reads invoice content (§10). |

### 3.2 Permission namespace
Independent top-level namespaces (no `finance.` parent); shared company financial data under `organization.financial.*`:
```
invoicing.invoices.{view|view.own|create|edit|send|cancel|void}
invoicing.quotes.{view|create|edit|send|convert}
invoicing.recurring.{view|create|edit|pause|cancel}
invoicing.customers.{view|create|edit|archive|delete}
invoicing.items.{view|create|edit|archive}
invoicing.notes.{view|create|send}                  # credit/debit notes
invoicing.payments.{view|record}
invoicing.reports.{view|export.gstr1|view.tds}
invoicing.settings.{view|edit}
invoicing.settings.numbering.edit
invoicing.settings.payments.edit
organization.financial.{view|edit}                  # SHARED: bank accounts, GSTIN, PAN, fiscal year
payroll.*                                            # RESERVED — separate module (Phase 2)
```

### 3.3 Default permission matrix (Invoicing)
`✓`=full · `R`=read-only · `own`=own records · `—`=none · `opt`=off by default, grantable by Owner/Admin.

| Capability | Owner | Admin | Finance | Auditor (default) | Manager | Employee |
|---|---|---|---|---|---|---|
| View invoices | ✓ | ✓ | ✓ | R | opt (R) | opt (own R) |
| Create / edit draft | ✓ | ✓ | ✓ | opt | — | — |
| Send invoice | ✓ | ✓ | ✓ | opt | — | — |
| Cancel / void | ✓ | ✓ | ✓ | — | — | — |
| Quotes (create/convert) | ✓ | ✓ | ✓ | opt | — | — |
| Recurring / subscriptions | ✓ | ✓ | ✓ | opt | — | — |
| Customers (add/edit/archive) | ✓ | ✓ | ✓ | R (opt edit) | opt (R) | — |
| Delete customer (hard) | ✓ | — | — | — | — | — |
| Items catalogue | ✓ | ✓ | ✓ | R | — | — |
| Credit / debit notes | ✓ | ✓ | ✓ | opt | — | — |
| Record payment | ✓ | ✓ | ✓ | opt | — | — |
| Reports (view) | ✓ | ✓ | ✓ | ✓ R | opt (R) | — |
| GSTR-1 export / TDS report | ✓ | ✓ | ✓ | ✓ | — | — |
| Invoicing Settings (view/edit) | ✓ | ✓ | ✓ | opt (R)/opt | — | — |
| Numbering — edit | ✓ | ✓ | ✓ (CA warning) | opt | — | — |
| Payments config (Razorpay connect) | ✓ | ✓ | R | R | — | — |
| Razorpay disconnect | ✓ only | — | — | — | — | — |
| Org → Financial details (view/edit) | ✓/✓ | ✓/✓ | ✓/opt | R/opt | — | — |
| Roles & Permissions; Billing | ✓ only | — | — | — | — | — |

Auditor default is **review-grade** (read + reports/GSTR-1/TDS + financial details view). Owner/Admin can elevate any `opt` at invite (e.g., a CA who also raises invoices). The granted set drives exactly what renders in the Auditor's sidebar.

### 3.4 Per-role experience
- **Owner:** full sidebar; full Invoicing section; company switcher if they own >1 company. Hosts "Invite auditor" (org Members, §3.5) and where bank accounts are first added (Organization → Financial details, prompted in the setup wizard). Guardrails: can't demote the last Owner; can't grant platform/FAM admin; can't edit sent invoices (Draft only).
- **Admin:** same minus billing, Roles & Permissions, owner-transfer, Razorpay disconnect. May invite auditors (default on).
- **Finance:** sidebar = Home + Invoicing; full Invoicing section; no company switcher. Daily overdue triage, manual payment recording, credit notes, month-end GSTR-1 export + CA hand-off. May edit Org → Financial details (if granted) and numbering (with CA-consult warning).
- **Auditor (headline role):** finance-scoped. Sidebar shows only granted financial modules (Invoicing now; Payroll later) + Home — no other modules, no Finance parent. **Company switcher always present.** Landing = **"My Companies"** (list of linked companies + light status, e.g. "3 overdue · GSTR-1 due in 4 days"); selecting one enters that company's isolated workspace. Inside a company, behaves per the granted set. **Non-billable seat.** Guardrails: never sees Roles & Permissions, Billing, Razorpay disconnect, member management, or any non-financial module; company switching is explicit and audit-logged.
- **Manager:** no Invoicing by default. If granted `invoicing.invoices.view`: read-only — edit/create CTAs **hidden** (not greyed), persistent "view-only" banner, "Record Payment" → "Contact Finance".
- **Employee:** none by default. If granted `invoicing.invoices.view.own`: read-only, **scoped to `created_by = self`**.

### 3.5 Auditor invitation & multi-company linking
Built on `users` + `memberships` (role `auditor`) — **no separate cross-tenant table or schema**. The `memberships` table *is* the multi-company registry.

**A. Invite (Owner/Admin, at org level — Settings → Members or People → Members → "Invite auditor"):**
1. Email + display name.
2. **Granted modules & access** checklist (drives the sidebar): Invoicing → ☐ View / ☐ Edit & create / ☐ Send / ☐ Record payments / ☐ Manage customers · Reports & GSTR-1/TDS export (default ✓ for auditors) · Invoicing Settings → ☐ View ☐ Edit · Org → Financial details → ☐ View ☐ Edit · *Payroll (reserved, disabled).*
3. Optional **access window** (`access_expires_at`) + note.
4. Send → insert a `memberships` row (`role='auditor'`, `status='pending'`, `is_external`, `invited_by`) + `membership_grants` rows. (Same-tenant ⇒ standard RLS.)

**B. Accept & switch (auditor):** authenticates via email-OTP (one global `users` row). If already an auditor elsewhere, the new company is simply **added** as another `memberships` row — no second login. Membership → `status='active'`. Lands on "My Companies"; the **company switcher** moves between clients by re-scoping the active `tenant_id`.

**C. Revoke:** Owner/Admin suspends/deletes the company's membership → auditor loses that company only; other links intact. FAM can revoke via service-role.

**Identity & RLS specifics:** one Clerk-free `users` identity; per-company `memberships(role='auditor')` + `membership_grants`. The company switcher **re-issues/refreshes the JWT** scoped to the chosen `tenant_id` *after re-verifying an active auditor membership there* (never trust a client-supplied tenant_id); RLS (`app.tenant_id`) then confines them to that company. Listing the auditor's own companies for the switcher uses a **SELECT-only self-visibility policy** on `memberships` keyed on `app.user_id` (§4.4); seats: billing counts `memberships WHERE role <> 'auditor' AND status='active'`.

---

## 4. Data model (complete)

All tables follow §1 conventions (UUID PK, `tenant_id` + RLS, timestamps, soft-delete, tenant-leading indexes). **§4.4 applies RLS to every table below.**

### 4.1 Reuse from foundation
`tenants` already provides `legal_name`, address, `gstin`, `pan`, `fiscal_year_start_month`, `currency`, `logo_url`, `brand_color`. The shared "Financial details" reads these; do not duplicate.

### 4.2 Invoicing tables

**`invoicing_settings`** — one row per tenant:
```sql
CREATE TABLE invoicing_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  default_currency TEXT NOT NULL DEFAULT 'INR',
  default_payment_terms_days INTEGER NOT NULL DEFAULT 30,
  default_gst_rate NUMERIC(5,2) NOT NULL DEFAULT 18,
  default_invoice_notes TEXT, default_terms_and_conditions TEXT,
  invoice_template TEXT NOT NULL DEFAULT 'classic',   -- v3 ships a SINGLE default template (§7.1)
  brand_color_override TEXT,
  show_gstin_on_pdf BOOLEAN DEFAULT TRUE, show_tds_section_on_pdf BOOLEAN DEFAULT TRUE,
  show_upi_qr_on_pdf BOOLEAN DEFAULT TRUE, show_powered_by_footer BOOLEAN DEFAULT TRUE,
  email_sender_name TEXT, email_reply_to TEXT, email_signature TEXT,
  cc_owner_on_customer_emails BOOLEAN DEFAULT TRUE, additional_cc_emails TEXT[],
  upi_id TEXT, upi_display_name TEXT,
  razorpay_account_id TEXT, razorpay_key_id TEXT, razorpay_webhook_secret TEXT,   -- encrypted
  allow_partial_payments BOOLEAN DEFAULT TRUE,
  fx_rate_source TEXT DEFAULT 'openexchangerates', fx_rate_last_refresh TIMESTAMPTZ,
  filing_frequency TEXT DEFAULT 'monthly',           -- monthly | quarterly
  declared_aato NUMERIC(15,2), composition_scheme BOOLEAN DEFAULT FALSE,
  default_tds_section TEXT DEFAULT '393', default_tds_payment_code TEXT,
  default_tds_rate NUMERIC(5,2), auto_suggest_tds BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**`invoicing_setup_progress`** — wizard tracker: one row/tenant with `wizard_started_at`, `wizard_completed_at`, `current_step`, and per-step booleans (`business_details_confirmed`, `upi_configured`, `razorpay_connected`, `template_chosen`, `numbering_configured`, `payment_terms_set`, `currencies_enabled`, `default_gst_set`, `default_notes_set`, `email_signature_set`, `reminder_schedule_set`), `first_invoice_sent_at`, timestamps.

**`customers`**:
```sql
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_code TEXT NOT NULL,                        -- unique within tenant
  display_name TEXT NOT NULL, legal_name TEXT,
  customer_type TEXT NOT NULL DEFAULT 'business',     -- business | individual
  primary_contact_name TEXT, email TEXT, secondary_emails TEXT[], phone TEXT,
  country_code TEXT NOT NULL DEFAULT 'IN', state_code TEXT,
  billing_address_line1 TEXT, billing_address_line2 TEXT, billing_city TEXT,
  billing_state TEXT, billing_postal_code TEXT, billing_country TEXT,
  shipping_same_as_billing BOOLEAN DEFAULT TRUE,
  shipping_address_line1 TEXT, shipping_address_line2 TEXT, shipping_city TEXT,
  shipping_state TEXT, shipping_postal_code TEXT, shipping_country TEXT,
  is_gst_registered BOOLEAN DEFAULT FALSE, gstin TEXT, pan TEXT, intl_tax_id TEXT,
  default_currency TEXT NOT NULL DEFAULT 'INR', default_payment_terms_days INTEGER,
  default_language TEXT DEFAULT 'en', default_notes TEXT, internal_notes TEXT,
  status TEXT NOT NULL DEFAULT 'active',               -- active | archived
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID REFERENCES users(id), updated_by UUID REFERENCES users(id), deleted_at TIMESTAMPTZ,
  UNIQUE(tenant_id, customer_code)
);
CREATE INDEX idx_customers_tenant_status ON customers(tenant_id, status);
CREATE INDEX idx_customers_email ON customers(tenant_id, email) WHERE email IS NOT NULL;
CREATE INDEX idx_customers_gstin ON customers(tenant_id, gstin) WHERE gstin IS NOT NULL;
```

**`customer_credit_balance`** — per (tenant, customer, currency): `balance_amount NUMERIC(15,2)`, `currency`, `UNIQUE(tenant_id, customer_id, currency)`.
**`customer_credit_balance_entries`** — append-only ledger: `entry_date`, `entry_type` (`credit_note|overpayment|adjustment|applied_to_invoice|refund`), `amount` (+credit/−use), `currency`, `reference_type`, `reference_id`, `description`, `created_by`. Index `(tenant_id, customer_id, entry_date DESC)`.

**`items`**:
```sql
CREATE TABLE items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_code TEXT NOT NULL, name TEXT NOT NULL, category TEXT, description TEXT,
  default_rate NUMERIC(15,2) NOT NULL, currency TEXT NOT NULL DEFAULT 'INR',
  unit TEXT NOT NULL DEFAULT 'units', hsn_sac_code TEXT,
  default_gst_rate NUMERIC(5,2) DEFAULT 18, cess_rate NUMERIC(5,2) DEFAULT 0,
  country_override TEXT, intl_tax_code TEXT, intl_tax_rate NUMERIC(5,2), tax_exempt BOOLEAN DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active', usage_count INTEGER DEFAULT 0, last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID REFERENCES users(id), updated_by UUID REFERENCES users(id), deleted_at TIMESTAMPTZ,
  UNIQUE(tenant_id, item_code)
);
CREATE INDEX idx_items_tenant_status ON items(tenant_id, status);
CREATE INDEX idx_items_name ON items USING gin(to_tsvector('english', name));
```

**`hsn_sac_codes`** — **global, read-only, NO RLS** (same for all tenants): `code UNIQUE`, `type` (`HSN|SAC`), `description`, `default_gst_rate`, `category`, `popularity`. Seed ~100 popular codes. GIN index on description. *(Tenants may add tenant-specific codes — store those tenant-scoped, e.g. in `items.hsn_sac_code` or a small tenant additions table; the master stays global.)*

**`invoice_sequences`** — one row per (tenant, document_type, FY); see §6.4 numbering and the v3 ALTER in §4.3:
```sql
CREATE TABLE invoice_sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,                 -- INVOICE | QUOTE | CREDIT_NOTE | DEBIT_NOTE
  fy_label TEXT NOT NULL,                       -- '26-27'
  fy_start_date DATE NOT NULL, fy_end_date DATE NOT NULL,
  prefix TEXT NOT NULL DEFAULT 'INV', separator TEXT NOT NULL DEFAULT '/',
  fy_format TEXT NOT NULL DEFAULT '26-27', zero_padding INTEGER NOT NULL DEFAULT 4,
  starting_number INTEGER NOT NULL DEFAULT 1, current_number INTEGER NOT NULL DEFAULT 0,
  branch_code VARCHAR(10) NOT NULL DEFAULT '',  -- v3: '' = single series; branch series is P1
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, document_type, fy_label, branch_code)
);
```

**`invoices`** — main table (also stores quotes via `document_type`/`status`):
```sql
CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  invoice_number TEXT NOT NULL, quote_number TEXT,
  document_type TEXT NOT NULL DEFAULT 'INVOICE',       -- INVOICE | QUOTE
  status TEXT NOT NULL DEFAULT 'DRAFT',
    -- DRAFT, SENT_AS_QUOTE, QUOTE_ACCEPTED, QUOTE_EXPIRED, SENT, VIEWED, PARTIALLY_PAID,
    -- OVERDUE, PAID, DISPUTED, CANCELLED, VOIDED, REFUNDED, WRITE_OFF,
    -- SCHEDULED, AUTO_GENERATING, AUTO_FAILED
  invoice_date DATE NOT NULL, due_date DATE NOT NULL, valid_until DATE,  -- valid_until for quotes
  reference TEXT, fy_label TEXT NOT NULL,
  currency TEXT NOT NULL, fx_rate_to_inr NUMERIC(15,6),  -- snapshot at creation
  subtotal NUMERIC(15,2) NOT NULL DEFAULT 0,
  discount_type TEXT, discount_value NUMERIC(15,2) DEFAULT 0, discount_amount NUMERIC(15,2) DEFAULT 0,
  taxable_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  cgst_amount NUMERIC(15,2) DEFAULT 0, sgst_amount NUMERIC(15,2) DEFAULT 0,
  igst_amount NUMERIC(15,2) DEFAULT 0, cess_amount NUMERIC(15,2) DEFAULT 0,
  total_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  tds_section TEXT, tds_payment_code TEXT, tds_rate NUMERIC(5,2), tds_amount NUMERIC(15,2) DEFAULT 0,
  net_receivable NUMERIC(15,2),
  amount_paid NUMERIC(15,2) DEFAULT 0, amount_outstanding NUMERIC(15,2), credit_applied NUMERIC(15,2) DEFAULT 0,
  place_of_supply TEXT, tax_treatment TEXT,             -- INTRA_STATE|INTER_STATE|EXPORT|B2C_LARGE|B2C_SMALL
  reverse_charge BOOLEAN DEFAULT FALSE,
  notes TEXT, terms_and_conditions TEXT,
  subscription_id UUID REFERENCES subscriptions(id),
  bank_account_id UUID REFERENCES tenant_bank_accounts(id),  -- v3: which company bank account renders on this invoice (§8)
  pdf_storage_key TEXT,                                  -- R2
  customer_email_at_send TEXT, email_sent_at TIMESTAMPTZ, email_delivered_at TIMESTAMPTZ,
  first_viewed_at TIMESTAMPTZ, last_viewed_at TIMESTAMPTZ, view_count INTEGER DEFAULT 0,
  paid_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ, cancellation_reason TEXT,
  voided_at TIMESTAMPTZ, refunded_at TIMESTAMPTZ, write_off_at TIMESTAMPTZ, write_off_reason TEXT,
  public_view_token TEXT UNIQUE, public_view_token_expires_at TIMESTAMPTZ,
  invoice_template TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID REFERENCES users(id), updated_by UUID REFERENCES users(id),
  UNIQUE(tenant_id, invoice_number)
);
CREATE INDEX idx_invoices_tenant_status ON invoices(tenant_id, status);
CREATE INDEX idx_invoices_tenant_customer ON invoices(tenant_id, customer_id);
CREATE INDEX idx_invoices_due_date ON invoices(tenant_id, due_date)
  WHERE status IN ('SENT','VIEWED','PARTIALLY_PAID','OVERDUE');
CREATE INDEX idx_invoices_public_token ON invoices(public_view_token);
```

**`invoice_line_items`**: `invoice_id` (FK, cascade), `line_number`, `item_id` (nullable for free-text), `item_name`, `description`, `hsn_sac_code`, `quantity NUMERIC(15,4)`, `unit`, `rate`, `gst_rate`, `cess_rate`, `line_amount`, `discount_amount`, `taxable_amount`, `cgst_amount`, `sgst_amount`, `igst_amount`, `cess_amount`, `line_total`, `UNIQUE(invoice_id, line_number)`.

**`invoice_payments`**: `invoice_id`, `customer_id`, `payment_number` (e.g. PMT-0001), `payment_date`, `amount`, `currency`, `payment_method` (`CASH|BANK_TRANSFER|CHEQUE|UPI_DIRECT|RAZORPAY_UPI|RAZORPAY_CARD|RAZORPAY_NETBANKING|RAZORPAY_WALLET|OTHER`), `reference_number` (UTR/cheque/razorpay id), `razorpay_payment_id`, `razorpay_order_id`, `notes`, `source` (`automatic_webhook|manual|subscription_charge`), `receipt_sent`, `UNIQUE(tenant_id, payment_number)`.

**`credit_notes`**: `invoice_id` (nullable for unallocated), `customer_id`, `credit_note_number`, `fy_label`, `credit_note_date`, `reason` (`sales_return|price_revision|post_supply_discount|service_deficiency|invoice_cancellation|other`), `reason_description`, `status` (`DRAFT|ISSUED|CANCELLED`), `currency`, `subtotal`, `taxable_amount`, `cgst/sgst/igst/cess_amount`, `total_amount`, `applied_to_balance`, `refunded_amount`, `refund_reference`, `refund_date`, `pdf_storage_key`, `notes`, `issued_at`, `cancelled_at`, `UNIQUE(tenant_id, credit_note_number)`.
**`credit_note_line_items`** — mirror `invoice_line_items`, linked to `credit_note_id`.
**`debit_notes`** — mirror `credit_notes` with `debit_note_number`/`debit_note_date` and reasons `additional_charges|price_revision_upward|under_billing_correction|reverse_charge_adjustment|other`.
**`debit_note_line_items`** — mirror.

**`adjustments`** — non-document balance adjustments: `customer_id`, `adjustment_date`, `amount` (+owe/−owed), `currency`, `type` (`opening_balance|write_off|round_off|bank_charge|other`), `reason`, `affects_credit_balance`, `created_by`.

**`subscriptions`** — recurring invoices:
```sql
CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_MANDATE',   -- PENDING_MANDATE|TRIALING|ACTIVE|PAST_DUE|PAUSED|CANCELLED|EXPIRED
  pricing_model TEXT NOT NULL,                       -- flat_rate | per_seat   (v3 ships these two only)
  currency TEXT NOT NULL,                            -- LOCKED at creation
  flat_amount NUMERIC(15,2), seat_rate NUMERIC(15,2), seat_count INTEGER,
  billing_period TEXT NOT NULL,                      -- monthly|quarterly|annually|custom
  custom_period_days INTEGER, anchor_day INTEGER, start_date DATE NOT NULL,
  end_condition TEXT NOT NULL DEFAULT 'until_cancelled', -- until_cancelled|after_n_cycles|on_date
  end_after_cycles INTEGER, end_date DATE,
  trial_days INTEGER DEFAULT 0, trial_ends_at DATE,
  next_billing_date DATE, next_billing_amount NUMERIC(15,2),
  razorpay_subscription_id TEXT UNIQUE, razorpay_plan_id TEXT,
  mandate_authorized_at TIMESTAMPTZ, mandate_revoked_at TIMESTAMPTZ,
  payment_method TEXT,                               -- upi_autopay | card
  total_cycles_billed INTEGER DEFAULT 0, total_amount_billed NUMERIC(15,2) DEFAULT 0,
  failed_charge_count INTEGER DEFAULT 0, last_failure_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ, cancellation_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), created_by UUID REFERENCES users(id)
);
CREATE INDEX idx_subscriptions_next_billing ON subscriptions(next_billing_date) WHERE status IN ('ACTIVE','TRIALING');
```
**`subscription_line_items`** — template lines (with `effective_from`/`effective_until` for mid-cycle changes). **`subscription_proration_events`** — pending pro-ration credits/debits: `event_date`, `event_type` (`add_seats|remove_seats|rate_change|other`), `amount` (+charge/−credit), `applied_to_invoice_id`.

**`reminder_schedule`** — per-tenant default schedule (overridable per customer/invoice): `reminder_number`, `offset_days` (−before/0 on/+after due), `active`, `email_subject_template`, `email_body_template`, `scope` (`tenant|customer|invoice`), nullable `customer_id`/`invoice_id`.
**`reminder_sent`** — idempotency + history: `invoice_id`, `reminder_number`, `offset_days`, `sent_at`, `delivered_at`, `bounced`, `UNIQUE(invoice_id, reminder_number)`.

**`razorpay_webhook_events`** — `event_id UNIQUE` (idempotency), `event_type`, `payload JSONB`, `signature`, `signature_verified`, `processed`, `processed_at`, `processing_error`, `retry_count`. (`tenant_id` nullable — some events are platform-level.)

**`gstr1_exports`** — audit of exports: `fy_label`, `period_month`, `period_year`, `format` (`json|csv`), `storage_key` (R2), `file_hash`, `invoice_count`, `total_taxable_value`, `total_tax`, `b2b_count`, `b2cl_count`, `b2cs_count`, `export_count`, `cdnr_count`, `generated_by`.

**`form_131_received`** — TDS Form 131 tracking (IT Act 2025): `customer_id`, `fy_label`, `quarter` (1–4), `total_tds_amount`, `form_131_received`, `form_131_received_date`, `form_131_storage_key` (R2), `expected_invoices UUID[]`, `UNIQUE(tenant_id, customer_id, fy_label, quarter)`.

**`audit_log`** (shared, all modules) — `id, tenant_id, actor_user_id, action, resource_type, resource_id, before_state JSONB, after_state JSONB, ip_address, user_agent, created_at`. **Every mutation in this module writes here.**

### 4.3 New v3 tables & alters

**`tenant_bank_accounts` (NEW)** — company bank accounts for the shared Financial details (§8):
```sql
CREATE TABLE tenant_bank_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  beneficiary_name TEXT NOT NULL,                 -- should match legal account holder
  account_number TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'Current',   -- Current | Savings | EEFC
  bank_name TEXT NOT NULL, branch TEXT,
  ifsc VARCHAR(11)  CHECK (ifsc IS NULL OR ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  swift_bic VARCHAR(11) CHECK (swift_bic IS NULL OR swift_bic ~ '^[A-Z0-9]{8}([A-Z0-9]{3})?$'),
  bank_address TEXT,                              -- required when used internationally (app-validated)
  iban VARCHAR(34),                              -- NULL for India; P2
  is_default BOOLEAN NOT NULL DEFAULT FALSE, is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID REFERENCES users(id), updated_by UUID REFERENCES users(id), deleted_at TIMESTAMPTZ
);
CREATE INDEX idx_tenant_bank_accounts_tenant ON tenant_bank_accounts(tenant_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_tenant_bank_default ON tenant_bank_accounts(tenant_id) WHERE is_default AND deleted_at IS NULL;

CREATE TABLE tenant_currency_bank_defaults (      -- one default account per currency
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  currency CHAR(3) NOT NULL,
  bank_account_id UUID NOT NULL REFERENCES tenant_bank_accounts(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, currency)
);
```

**`membership_grants` (NEW)** — per-membership module scopes (drives Auditor sidebar + guards):
```sql
CREATE TABLE membership_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,   -- == membership's tenant
  membership_id UUID NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  module TEXT NOT NULL,                  -- invoicing | reports | org_financial | payroll(reserved) | expenses(reserved)
  access_level TEXT NOT NULL DEFAULT 'view',  -- none | view | edit
  capabilities JSONB NOT NULL DEFAULT '{}',   -- {"send":true,"record_payment":true,"manage_customers":false}
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (membership_id, module)
);
CREATE INDEX idx_membership_grants_membership ON membership_grants(membership_id);
```
Default auditor grant on invite: `invoicing:view`, `reports:view`, `org_financial:view`.

**`memberships` (ALTER)** — support the Auditor role:
```sql
ALTER TABLE memberships
  ADD COLUMN is_external BOOLEAN NOT NULL DEFAULT FALSE,    -- external CA vs internal reviewer
  ADD COLUMN access_expires_at TIMESTAMPTZ;                -- P1 time-boxed engagement
-- role gains value 'auditor' (VARCHAR(40); app-level validation, no enum change)
```

**`invoice_sequences` (ALTER)** — already reflected in §4.2 (added `branch_code` + the 4-col unique). If the column does not yet exist in the running DB, this is the migration that adds it and rebuilds the unique constraint.

**`tenant_module_toggles` (NEW)** — FAM per-module enablement:
```sql
CREATE TABLE tenant_module_toggles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  module TEXT NOT NULL,                  -- invoicing | payroll | expenses
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by UUID REFERENCES users(id), updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, module)
);
-- seed invoicing = enabled for all tenants
```

### 4.4 RLS to apply
- **Tenant-scoped (ENABLE + FORCE + `tenant_isolation_*`):** `invoicing_settings`, `invoicing_setup_progress`, `customers`, `customer_credit_balance`, `customer_credit_balance_entries`, `items`, `invoice_sequences`, `invoices`, `invoice_line_items`, `invoice_payments`, `credit_notes`, `credit_note_line_items`, `debit_notes`, `debit_note_line_items`, `adjustments`, `subscriptions`, `subscription_line_items`, `subscription_proration_events`, `reminder_schedule`, `reminder_sent`, `gstr1_exports`, `form_131_received`, **`tenant_bank_accounts`**, **`tenant_currency_bank_defaults`**, **`membership_grants`**, **`tenant_module_toggles`**, and `audit_log`.
- **Global, no RLS:** `hsn_sac_codes`.
- **`razorpay_webhook_events`:** written by the webhook handler (no tenant context on inbound); access it via the service layer / FAM service-role, not tenant controllers.
- **`memberships` self-visibility (NEW, for the company switcher):**
  ```sql
  CREATE POLICY memberships_self_visibility ON memberships
    FOR SELECT USING (user_id = current_setting('app.user_id', true)::uuid);
  ```
  Requires `app.user_id` to be set in request context (§1). Permissive policies OR together, so writes/tenant-reads stay governed by `tenant_isolation_memberships`; this only additionally exposes the caller's own rows across tenants.
- Add every new table to the cross-tenant CI suite; add an **auditor-in-A-and-B** test (while scoped to A, zero B rows; cannot write B).

---

## 5. API surface

All under `/api/v1/...`, JWT bearer, envelope `{ data, meta?, errors? }`. Role column lists who may call; RLS still confines rows to the active tenant.

**Customers** — `GET/POST /customers`, `GET/PATCH /customers/:id`, `POST /customers/:id/archive|unarchive`, `GET /customers/:id/statement`, `POST /customers/:id/statement/email`, `POST /customers/import`, `GET /customers/export`.
**Items** — `GET/POST /items`, `GET/PATCH /items/:id`, `POST /items/:id/archive`, `POST /items/import`, `GET /items/export`.
**HSN/SAC** — `GET /hsn-sac/search?q=`, `POST /hsn-sac/custom` (Owner/Admin), `DELETE /hsn-sac/custom/:id`.
**Invoices** — `GET/POST /invoices`, `GET/PATCH /invoices/:id` (PATCH only if DRAFT), `POST /invoices/:id/send`, `/send-as-quote`, `/convert-to-invoice`, `/duplicate`, `/cancel` (auto-CN if GST), `/void` (within 24h, not viewed), `/write-off`, `GET /invoices/:id/pdf`, `POST /invoices/:id/resend`, `/record-payment`, `GET /invoices/:id/timeline`, `POST /invoices/:id/reminders/send`, `GET /invoices/sequences`, `PATCH /invoices/sequences/:id` (warn on mid-FY change).
**Credit/Debit notes & adjustments** — `GET/POST /credit-notes`, `GET/PATCH /credit-notes/:id`, `POST /credit-notes/:id/issue|email|record-refund`, `GET /credit-notes/:id/pdf`; same for `/debit-notes/*`; `GET/POST /adjustments`, `GET /adjustments/:id`, `DELETE /adjustments/:id` (only if <24h old; audit-logged).
**Subscriptions** — `GET/POST /subscriptions`, `GET/PATCH /subscriptions/:id`, `POST /subscriptions/:id/update-seats|pause|resume|cancel`, `GET /subscriptions/:id/invoices`, `GET /subscriptions/:id/mandate-link`.
**Reports** — `GET /reports/dashboard|aging|revenue|subscriptions-metrics|tds-receivable`, `POST /reports/gstr1/generate`, `GET /reports/gstr1/:export_id`, `GET /reports/gstr1/history`, `GET /reports/form-131-tracking`, `POST /reports/form-131/:id/mark-received`.
**Settings (Invoicing)** — `GET /settings`, `PATCH /settings/general|numbering/:document_type|templates|email|reminders|currencies|compliance`, `POST /settings/upi`, `POST /settings/razorpay/connect`, `POST /settings/razorpay/disconnect` (Owner), `GET/PATCH /settings/setup-progress`.
**Settings (Organization → Financial details — NEW, shared):** `GET /org/financial`, `PATCH /org/financial` (GSTIN/PAN/FY on `tenants`); **bank accounts:** `GET/POST /org/financial/bank-accounts`, `GET/PATCH/DELETE /org/financial/bank-accounts/:id`, `POST /org/financial/bank-accounts/:id/set-default`, `PUT /org/financial/currency-default` (`{currency, bank_account_id}`).
**Members / Auditor (NEW):** `GET/POST /members`, `POST /members/invite-auditor` (`{email, name, grants[], access_expires_at?}`), `PATCH /members/:membershipId/grants`, `DELETE /members/:membershipId` (revoke), `GET /me/companies` (switcher list — uses self-visibility), `POST /auth/switch-company` (`{tenant_id}` → re-issues JWT after membership re-verify).
**FAM (platform, service-role; NEW):** `GET /fam/tenants/:id/modules`, `PATCH /fam/tenants/:id/modules/:module` (toggle), `GET /fam/auditors` (registry: auditor email ↔ companies ↔ status), `DELETE /fam/auditors/:userId/companies/:tenantId` (revoke), `GET /fam/tenants/:id/seats` (member vs auditor split), `GET /fam/metrics`.
**Public (no auth, signed token)** — `GET /public/inv/:token`, `POST /public/inv/:token/track`, `POST /public/inv/:token/pay/razorpay`, `POST /public/inv/:token/dispute`, `GET /public/inv/:token/pdf`; `GET /public/q/:token`, `POST /public/q/:token/accept|decline`; `GET /public/customer/:token` (+ subscription views/cancel-request/update-mandate).
**Webhooks** — `POST /webhooks/razorpay` (signature-verified), `POST /webhooks/resend/email-events`.
**Background jobs (BullMQ / Upstash):** `mark-overdue-invoices` (hourly), `expire-quotes` (hourly), `send-reminders` (hourly), `generate-subscription-invoices` (hourly), `send-pre-debit-notifications` (hourly, 24h before next charge), `retry-failed-subscription-charges` (daily, dunning), `refresh-fx-rates` (daily 06:00 IST), `notify-gstr1-export-ready` (1st of month 09:00 IST), `quarterly-form-131-reminder` (1 Apr/Jul/Oct/Jan 09:00 IST).

---

## 6. Business rules

### 6.1 GST
- **Place of supply** + supplier state decide the split: **intra-state → CGST + SGST** (each = rate/2); **inter-state / export → IGST** (full rate). `tax_treatment ∈ {INTRA_STATE, INTER_STATE, EXPORT, B2C_LARGE, B2C_SMALL}`. Cess applies on top where set. Exports are zero-rated (IGST 0 with LUT, or with IGST + refund).
- Per-line tax computed on each line's `taxable_amount` (after line discount); invoice totals are the sum. Round per the GST rounding rule. Store both per-line and invoice-level tax columns (already in schema).
- `place_of_supply` defaults from customer state; user-overridable. B2C large/small split by the prevailing threshold.

### 6.2 TDS (Income Tax Act 2025)
- Section **393** with **payment codes** (e.g. 10XX/20XX/30XX); `tds_rate` applied to the taxable base; **`net_receivable = total_amount − tds_amount`**, shown live in the editor and on the invoice. **Form 131** is the new TDS certificate the customer issues — tracked in `form_131_received`.
- ⚠️ The specific Section 393 **payment codes** ship as **illustrative pending CFO sign-off** — do not hard-code final codes until confirmed (see §13 open items).

### 6.3 Pricing models (v3 scope)
Only **flat-rate** and **per-seat** ship in v3 (tiered and usage-based are deferred). Per-seat: `seat_rate × seat_count`; seat changes mid-cycle create `subscription_proration_events` applied to the next invoice.

### 6.4 Invoice numbering (editable, GST-compliant)
Per-document-type sequences (Invoice/Quote/Credit Note/Debit Note), each: prefix · separator · FY token (e.g. `26-27`) · zero-padding · starting number, with a live "next number" preview. **Auto FY reset on April 1** (default on): restart at the start number with the new FY token. Optional **branch-wise series** (P1; `branch_code`) — GST permits multiple series if each is sequential & unique within the FY.
**Validation (hard, on save):** total ≤ **16 characters**; allowed charset **alphanumerics + `-` and `/` only**; **consecutive & unique per FY**; **gap detection** with an Owner/Admin resequence affordance; mid-FY prefix/start change warns *"can break GST compliance — consult your CA."* Editing an individual **sent** invoice's number stays blocked (Draft only). **Reserve numbers atomically** inside the tenant transaction (`SELECT … FOR UPDATE` then increment `current_number`).

### 6.5 Invoice lifecycle
`DRAFT → SENT → VIEWED → (PARTIALLY_PAID) → PAID`; `OVERDUE` when `due_date` passes while unpaid; `CANCELLED` (auto-issues a credit note if the invoice carried GST); `VOIDED` (within 24h and not viewed); `WRITE_OFF`; `REFUNDED`; `DISPUTED`. Quotes: `SENT_AS_QUOTE → QUOTE_ACCEPTED | QUOTE_EXPIRED`, convertible to an invoice. Subscription-generated: `SCHEDULED → AUTO_GENERATING → SENT` (or `AUTO_FAILED`). Edits allowed only in `DRAFT`.

### 6.6 Payments
Record manually (cash/bank/cheque/UPI/etc.) or automatically via Razorpay webhook (`payment.captured`). Partial payments allowed (toggle). On payment, update `amount_paid`/`amount_outstanding`, transition status, optionally send a receipt. Overpayment → customer credit balance entry.

### 6.7 Credit/Debit notes
GST CDNR documents against an invoice (or unallocated). Issuing a credit note adjusts the customer's credit balance (and may drive a refund). Both carry their own numbering series and feed GSTR-1 CDNR.

### 6.8 Subscriptions & dunning
Razorpay mandate (UPI Autopay / card). `generate-subscription-invoices` creates invoices on `next_billing_date`; `send-pre-debit-notifications` fires **24h before** the charge. **Dunning: 3 retries over 7 days**; after the final failure → **pause** the subscription (status `PAST_DUE` → `PAUSED`), notify the tenant. Mid-cycle seat/rate changes → proration events on the next invoice.

### 6.9 Reminders
Driven by `reminder_schedule` `offset_days` (−before / 0 on / +after due), up to ~10 steps, overridable per customer/invoice. `send-reminders` runs hourly; `reminder_sent` gives idempotency + history (and bounce tracking via Resend webhooks).

### 6.10 Multi-currency & FX
INR (locked) + USD/EUR/GBP toggles. `refresh-fx-rates` pulls daily from openexchangerates.org; `fx_rate_to_inr` is **snapshotted at invoice creation** and never re-floated. Currency drives the bank block / SWIFT logic (§8) and the public payment options (UPI QR only for INR).

### 6.11 GSTR-1 export & Form 131
`POST /reports/gstr1/generate` builds the period file (JSON/CSV) bucketed into B2B / B2CL / B2CS / EXP / CDNR, stored in R2 with a hash, logged in `gstr1_exports`. Form 131 (TDS certificates) tracked quarterly per customer in `form_131_received`; quarterly reminder job nudges follow-ups. Exports are **Tally/GST-portal-compatible**; the platform does **not file** returns.

---

## 7. Settings — per-module + shared Organization → Financial details

**No combined finance-settings tab.** Each module owns its settings; company-wide financial fields live once at the Organization level.

### 7.1 Invoicing Settings (`/app/invoicing/settings`) sub-tabs
| Sub-tab | Contents | Editable by |
|---|---|---|
| Numbering | The 4 sequences + validation (§6.4) | Owner, Admin, Finance |
| Template | **Single default template** + brand color + logo override; "more templates coming soon" | Owner, Admin |
| Email & Reminders | Sender, reply-to, signature, subject templates; reminder schedule | Owner, Admin, Finance |
| Payments | UPI ID + "Test"; Razorpay connect/disconnect (disconnect = Owner only); methods; partial payments | Owner, Admin |
| Currencies | INR locked + USD/EUR/GBP toggles; FX source/refresh | Owner, Admin |
| Tax codes | HSN/SAC custom additions; international tax categories | Owner, Admin, Finance |
| Compliance | GST settings; TDS Section 393 / payment-code preferences | Owner, Admin, Finance |

### 7.2 Organization → Financial details (`/app/settings/organization`, shared)
Read by Invoicing now and Payroll later (one source of truth). Holds legal name, address, **GSTIN**, **PAN**, **fiscal year** (these are **columns on `tenants`** — reuse, don't duplicate) plus the **company bank accounts** (§8). Bank details are **not** inside Invoicing settings.

---

## 8. Company bank details + conditional SWIFT/IFSC

Stored in `tenant_bank_accounts` (+ `tenant_currency_bank_defaults`), surfaced under Organization → Financial details, and auto-rendered on the invoice, preview, public page, and PDF.

**Settings UX:** a "Bank accounts" list (Add / Edit / Set default / Set default-for-currency / Deactivate). Add/Edit shows **conditional fields**: always beneficiary name, account number, account type, bank name, branch; **IFSC** for INR accounts (validated); **SWIFT/BIC + bank address** when the account is usable for foreign currency (validated). Warn if `beneficiary_name` ≠ legal account holder name ("mismatched names can cause your bank to hold incoming transfers").

**Invoice-time rule (currency-driven):**
- Selection order: `tenant_currency_bank_defaults[invoice.currency]` → else overall `is_default` → else first active. User may override per invoice (stored on `invoices.bank_account_id`).
- **Render:** invoice currency **INR (domestic)** ⇒ show **IFSC + account number** (hide SWIFT); invoice currency **USD/EUR/GBP/other (or customer non-Indian)** ⇒ show **SWIFT/BIC + account number + bank address** (IFSC optional/hidden).

**Acceptance criteria:**
- [ ] INR invoice → bank block shows IFSC + account number, **no SWIFT**.
- [ ] USD invoice → bank block shows **SWIFT/BIC + account number + bank address**.
- [ ] Indian company, USD invoice, no SWIFT saved → editor warns "Add a SWIFT/BIC to accept international transfers"; Razorpay/UPI still offered.
- [ ] With INR + USD accounts and per-currency defaults set, changing invoice currency swaps the bank block automatically.
- [ ] Malformed IFSC/SWIFT rejected with a clear message.
- [ ] Editing a bank account in Organization → Financial details is reflected in new invoices immediately (single source of truth).

**Security:** treat `account_number` as sensitive — rely on Supabase encryption-at-rest **and** mask all but the last 4 digits in non-privileged API responses; full value only for Owner/Admin/Finance/Auditor with `org_financial:view`.

---

## 9. Invoice editor, preview & hosted public view

### 9.1 Editor (single-column — no split-pane / no live preview)
Full-width single-column form. Top bar: `← Back · Invoice #<auto> · [Preview] · [Save Draft] · [Send ▾]`. Sections top-to-bottom: **Customer** (searchable + inline create) → **Meta** (date, due, currency, reference) → **Line items** (keyboard-navigable table; Tab across, Enter adds a row) → **Discount** → **TDS block** (Section 393, code dropdown, live net-receivable) → **Bank account selector** (auto-picked by currency from Organization → Financial details, overridable) → **Notes / T&C**. A small **live totals card** shows subtotal/GST/TDS/net-receivable inline — so the user gets live numbers **without** a rendered-invoice pane.

### 9.2 Preview = button-triggered, full-page, chrome-less
Clicking **Preview** opens the invoice as a **standalone full page** at `/app/invoicing/:id/preview` — **no sidebar, no app chrome** — exactly as the customer will see it. A slim top action bar: `← Close · [Edit] · [Download PDF] · [Send ▾] · [Open in new tab]`. Full-screen on mobile. **The preview renderer is the same component as the public page (9.3)** — single source of truth.
**Acceptance:** preview shows the currency-correct bank block + TDS; "Edit" returns to the editor with state intact; preview is visually identical to the public page minus the customer pay controls.

### 9.3 Hosted public invoice page (the customer's view)
**"Send"** delivers an email whose primary CTA is a **"View & Pay" link** to `{tenant-slug}.flickssuite.com/inv/{token}` — **no PDF attachment by default** (lighter, trackable, always current); the customer can Download PDF from the page. The page shows **only the invoice + payment methods**, **no app chrome**, on the tenant's branded subdomain: the rendered invoice, then a **payment block** — **UPI QR (INR only)** + **"Pay with Razorpay"** + **bank transfer details with conditional SWIFT/IFSC** — then T&C. Light/dark. Opening it fires the view-tracking pixel (`SENT → VIEWED`). Signed token scopes to exactly one invoice and cannot enumerate others.
**Acceptance:** customer sees branded invoice + payment methods, no Flicks Suite navigation; INR → UPI QR present; USD → no UPI QR, Razorpay + SWIFT bank block present; "send without PDF" email leads with the hosted link; downloadable PDF matches the page.

---

## 10. FAM (Specflicks platform admin)

`admin.flickssuite.com`; uses the `flicks_service_role` (BYPASSRLS) in its service layer only. **Hard privacy line: FAM never reads invoice content** (customers, amounts, descriptions) without explicit, time-boxed, audited tenant consent.
1. **Per-module toggles (no Finance parent):** `tenant_module_toggles` for `invoicing` (live), `payroll`/`expenses` (reserved). Default `invoicing=enabled`. A NestJS guard checks the toggle before serving `/api/v1/invoicing/*` (toggle **wins over** any grant).
2. **Auditor-link registry:** read-only view of `memberships WHERE role='auditor'` joined to `tenants`/`users` — auditor email ↔ companies ↔ status ↔ access window. FAM can **revoke** a link; FAM cannot see financial content.
3. **Seat accounting split:** member seats (billable) vs auditor seats (non-billable) per tenant and platform-wide.
4. **Anonymized aggregate metrics:** # tenants with ≥1 auditor; # multi-company auditors; median companies/auditor; # tenants with ≥1 bank account; # generating foreign-currency invoices (SWIFT usage); invoicing adoption / time-to-first-invoice.
5. **Consented debug:** with Owner consent, view a tenant's invoice **count/status distribution**, Razorpay webhook log, email-delivery log, and audit entries — logged + revocable.

---

## 11. Setup wizard

A guided wizard on first entry to Invoicing (~12 steps): confirm business details; UPI; Razorpay connect; **confirm the single default template** (logo + brand color — no template choice); numbering; payment terms; currencies; default GST; default notes; email signature; reminder schedule; **add company bank account(s)** (writes to Organization → Financial details; conditional IFSC/SWIFT per §8; skippable — UPI/Razorpay still work). Progress tracked in `invoicing_setup_progress`. Final CTA: **"Save → Create first invoice."**

---

## 12. Migrations

Drizzle migrations in `apps/api/src/db/migrations/`, ordered, applied as atomic deploys; run the cross-tenant CI suite after each.

**Foundation (if not already present):** `tenants`, `users`, `memberships` (+ RLS) come first.

**Invoicing core (create the §4.2 tables, in order):**
`invoicing_settings` → `invoicing_setup_progress` → `customers` → `customer_credit_balance` (+entries) → `items` → `hsn_sac_codes` (+ seed ~100) → `invoice_sequences` → `invoices` (+ `invoice_line_items`) → `invoice_payments` → `credit_notes` (+lines) → `debit_notes` (+lines) → `adjustments` → `subscriptions` (+line_items, +proration_events) → `reminder_schedule` (+`reminder_sent`) → `razorpay_webhook_events` → `gstr1_exports` → `form_131_received` → **apply RLS to all of the above.**

**v3 additions (continue numbering):**
| Migration | Description |
|---|---|
| `…_v3_tenant_bank_accounts` | `tenant_bank_accounts` + `tenant_currency_bank_defaults` (+ RLS, indexes) |
| `…_v3_membership_grants` | `membership_grants` (+ RLS, indexes) |
| `…_v3_memberships_auditor` | ALTER `memberships` (`is_external`, `access_expires_at`) + `memberships_self_visibility` SELECT policy |
| `…_v3_invoice_sequences_branch` | ALTER `invoice_sequences` (`branch_code` + 4-col unique) — if not already in the base table |
| `…_v3_tenant_module_toggles` | `tenant_module_toggles` (+ RLS) + seed `invoicing=enabled` |
| `…_v3_request_context` | Ensure `db.runQuery` sets `app.user_id` (for the switcher) and standardize on `app.tenant_id` |

*(If the invoicing core already exists in the codebase at migration `0068`, the v3 additions are `0069`–`0074`.)*

---

## 13. Non-goals · success metrics · open questions · build order

### 13.1 Non-goals (v3)
1. **Building Payroll/Expenses now** — only reserve the separate module slots + the shared Financial-details block.
2. **Cross-company consolidated financials for auditors** — one active company at a time; no mixed ledger/roll-up (a read-only multi-company *status* landing is a P1 stretch).
3. **Filing GST/TDS returns** — export only.
4. **Multiple invoice templates / customization** — one default template (P2).
5. **Full double-entry accounting / chart of accounts.**
6. **Tiered / usage-based pricing** — flat-rate + per-seat only (deferred to a later release).
7. **Non-INR/non-USD bank localization beyond SWIFT** — SEPA IBAN, US routing, UK sort-code are P2.
8. **Multi-module rail shell** (Huly-style icon rail + context panel + workbench tabs) — **deferred** to a later deliberate suite-wide redesign once module count/funding justify it; keep the nav component swappable.

### 13.2 Success metrics
- Invoice-creation completion rate & time-to-create (single-column should match or beat the prior baseline); public page **View → Pay** conversion (instrument at launch); reduced "where is X" / "what are your bank details" support tickets.
- **% of finance-tier tenants that invite an auditor within 90 days** (north-star for the role); # multi-company auditors; time-to-payment on foreign-currency invoices.

### 13.3 Open questions (decide before merge; none block the design)
| # | Question | Owner | Blocking? |
|---|---|---|---|
| Q1 | Confirm the auditor RLS design: `memberships.role='auditor'` + `membership_grants`; company switcher re-scopes the JWT's active `tenant_id`; `memberships` self-visibility SELECT policy keyed on `app.user_id` (requires setting `app.user_id`). Grants as a table vs JSONB. | Engineering | **Yes** (gates Auditor) |
| Q2 | Auditor default access — review-grade read+export (this doc), or zero until each module is explicitly granted? | Product | Yes |
| Q3 | Auditor seat billing — confirm auditor seats are free and how that interacts with the per-user plan. | Product/Business | Yes |
| Q4 | Bank accounts in v3 — multi-account + per-currency default now (this doc), or single account now? | Product | No |
| Q5 | Branch-wise numbering needed for any current customer, or safe to keep P1? | Product | No |
| Q6 | Show a disabled "Payroll — coming soon" sidebar item now, or render nothing? | Design | No |
| Q7 | Account-number masking policy (last-4 to non-privileged) — confirm. | Eng/Security | No |
| Q8 | **TDS Section 393 payment codes** remain illustrative pending CFO sign-off — confirm before hard-coding. | Compliance | Yes (TDS copy) |

### 13.4 Suggested build order
1. (If needed) foundation: `tenants`/`users`/`memberships` + RLS infra + the request-context session vars (`app.tenant_id`, `app.user_id`).
2. Invoicing core data model (§4.2) + RLS + the cross-tenant CI suite.
3. Customers, items, invoice CRUD, numbering (§6.4), single-column editor (§9.1).
4. Send + full-page preview + hosted public page (shared renderer) + Razorpay/UPI payment + webhooks.
5. Organization → Financial details + bank accounts with conditional SWIFT (§8).
6. Credit/debit notes, adjustments, customer ledger; reminders; GSTR-1 + Form 131 reports.
7. Subscriptions + mandate + dunning jobs.
8. Auditor role: `membership_grants`, invite/accept/revoke, company switcher (JWT re-scope), "My Companies", self-visibility policy, non-billable seats.
9. FAM: module toggles + guard, auditor registry, seat split, metrics.
10. Settings polish; P1 items (branch series, auditor access windows, My-Companies status chips).

**Dependency:** Q1 must resolve before step 8; everything else can proceed in parallel.

## Document End
*Self-contained Invoicing Module development PRD (v3): platform foundation, complete data model, API surface, business rules, and all v3 features (separate Invoicing/Payroll modules · v1 sidebar + company switcher · Auditor multi-company role · conditional bank details · GST-compliant editable numbering · single-column editor + full-page preview + hosted public view · per-module settings + shared Organization Financial details · FAM updates). No other document required; pair with the approved design files.*
