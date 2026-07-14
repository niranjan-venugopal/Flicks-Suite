#!/usr/bin/env bash
#
# Flicks Suite — CRM sample-data pack (C22, PRD v5).
#
#   bash scripts/seed-crm-sample.sh [tenant-slug]
#
# Seeds a realistic, REMOVABLE CRM test set into ONE tenant so the deals phase
# can be click-tested without hand-entering data:
#   • 6 companies + 8 contacts (source='sample')
#   • 8 deals spread across the pipeline — values, currencies, tags, one rotting
#     amber + one red, expected-close dates (source='sample')
#   • products on the flagship deal (so deal→invoice/quote carries real lines)
#   • 2 tags (enterprise / renewal)
#   • static FX reference rates for today (USD/EUR/GBP/SGD/AED vs INR) so
#     non-base-currency deals work without an OPENEXCHANGERATES key. The daily
#     FX job overwrites these with real rates once the key is set.
#
# IDEMPOTENT: safe to re-run (skips anything that already exists by name).
# REMOVABLE: everything carries source='sample' — delete with:
#   DELETE FROM deals   WHERE tenant_id = <t> AND source = 'sample';
#   DELETE FROM directory_people    WHERE tenant_id = <t> AND source = 'sample';
#   DELETE FROM directory_companies WHERE tenant_id = <t> AND source = 'sample';
#
# Targets the tenant by slug ($1); with no argument, the OLDEST tenant.
# Uses the same privileged connection resolution as sync-supabase.sh.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/apps/api/.env"

envval() {
  [[ -f "$ENV_FILE" ]] || return 0
  grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- \
    | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

: "${DATABASE_DIRECT_URL:=$(envval DATABASE_DIRECT_URL)}"
: "${DATABASE_DIRECT_URL:=$(envval DATABASE_SERVICE_ROLE_URL)}"
if [[ -z "${DATABASE_DIRECT_URL:-}" ]]; then
  echo "ERROR: set DATABASE_DIRECT_URL (or DATABASE_SERVICE_ROLE_URL) in apps/api/.env" >&2
  exit 1
fi

SLUG="${1:-}"

psql "$DATABASE_DIRECT_URL" -v ON_ERROR_STOP=1 -v slug="$SLUG" <<'SQL'
-- psql variables don't reach into dollar-quoted DO bodies; hand the slug over
-- as a session GUC instead.
SELECT set_config('seed.slug', :'slug', false);

DO $seed$
DECLARE
  v_tenant uuid;
  v_owner uuid;
  v_pipeline uuid;
  v_slug text := current_setting('seed.slug', true);
  s_ids uuid[];
  v_co uuid; v_co2 uuid; v_co3 uuid;
  v_p1 uuid; v_p2 uuid;
  v_deal uuid;
  v_tag_ent uuid; v_tag_ren uuid;
  n int;
BEGIN
  -- Resolve tenant (by slug when given, else oldest) + an owner/admin actor.
  IF v_slug IS NOT NULL AND v_slug <> '' THEN
    SELECT id INTO v_tenant FROM tenants WHERE slug = v_slug;
    IF v_tenant IS NULL THEN RAISE EXCEPTION 'No tenant with slug "%"', v_slug; END IF;
  ELSE
    SELECT id INTO v_tenant FROM tenants ORDER BY created_at LIMIT 1;
    IF v_tenant IS NULL THEN RAISE EXCEPTION 'No tenants exist yet — sign up first'; END IF;
  END IF;
  SELECT m.user_id INTO v_owner FROM memberships m
    WHERE m.tenant_id = v_tenant AND m.status = 'active'
    ORDER BY CASE m.role::text WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END
    LIMIT 1;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Tenant has no active member to own the sample deals'; END IF;

  -- Pipeline: reuse the tenant's first; seed the default "Sales" if missing
  -- (tenants created after migration 0032 have none).
  SELECT id INTO v_pipeline FROM pipelines WHERE tenant_id = v_tenant AND deleted_at IS NULL ORDER BY display_order LIMIT 1;
  IF v_pipeline IS NULL THEN
    INSERT INTO pipelines (tenant_id, name, is_default, display_order) VALUES (v_tenant, 'Sales', true, 0) RETURNING id INTO v_pipeline;
    INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, display_order, win_probability, rotting_days, stage_type) VALUES
      (v_tenant, v_pipeline, 'Qualified',      0, 10,  NULL, 'open'),
      (v_tenant, v_pipeline, 'Contact Made',   1, 25,  NULL, 'open'),
      (v_tenant, v_pipeline, 'Demo Scheduled', 2, 40,  7,    'open'),
      (v_tenant, v_pipeline, 'Proposal Sent',  3, 60,  10,   'open'),
      (v_tenant, v_pipeline, 'Negotiation',    4, 80,  10,   'open'),
      (v_tenant, v_pipeline, 'Won',            5, 100, NULL, 'won'),
      (v_tenant, v_pipeline, 'Lost',           6, 0,   NULL, 'lost');
  END IF;
  SELECT array_agg(id ORDER BY display_order) INTO s_ids
    FROM pipeline_stages WHERE pipeline_id = v_pipeline AND deleted_at IS NULL AND stage_type = 'open';

  -- FX reference rates for today (USD base) — only the missing ones.
  INSERT INTO fx_rates (base, quote, rate, as_of) VALUES
    ('USD','USD',1,        CURRENT_DATE),
    ('USD','INR',83.50,    CURRENT_DATE),
    ('USD','EUR',0.92,     CURRENT_DATE),
    ('USD','GBP',0.79,     CURRENT_DATE),
    ('USD','SGD',1.35,     CURRENT_DATE),
    ('USD','AED',3.6725,   CURRENT_DATE)
  ON CONFLICT (base, quote, as_of) DO NOTHING;

  -- Tags.
  INSERT INTO tags (tenant_id, label, color)
    SELECT v_tenant, 'enterprise', '#9B7BFA' WHERE NOT EXISTS (SELECT 1 FROM tags WHERE tenant_id = v_tenant AND lower(label) = 'enterprise');
  INSERT INTO tags (tenant_id, label, color)
    SELECT v_tenant, 'renewal', '#27D280' WHERE NOT EXISTS (SELECT 1 FROM tags WHERE tenant_id = v_tenant AND lower(label) = 'renewal');
  SELECT id INTO v_tag_ent FROM tags WHERE tenant_id = v_tenant AND lower(label) = 'enterprise';
  SELECT id INTO v_tag_ren FROM tags WHERE tenant_id = v_tenant AND lower(label) = 'renewal';

  -- Companies (idempotent by name).
  CREATE TEMP TABLE _cos (name text, domain text, industry text, city text, cc char(2)) ON COMMIT DROP;
  INSERT INTO _cos VALUES
    ('TechCorp Inc',        'techcorp.io',      'Software',    'Bengaluru', 'IN'),
    ('Meridian Group',      'meridian.example', 'Logistics',   'Mumbai',    'IN'),
    ('Bluewave Analytics',  'bluewave.example', 'Analytics',   'Singapore', 'SG'),
    ('Nimbus Retail',       'nimbus.example',   'Retail',      'Delhi',     'IN'),
    ('Kavya Textiles',      'kavya.example',    'Manufacturing','Coimbatore','IN'),
    ('Northwind Traders',   'northwind.example','Wholesale',   'Dubai',     'AE');
  INSERT INTO directory_companies (tenant_id, name, domain, industry, city, country_code, source, created_by)
    SELECT v_tenant, c.name, c.domain, c.industry, c.city, c.cc, 'sample', v_owner
    FROM _cos c
    WHERE NOT EXISTS (SELECT 1 FROM directory_companies d WHERE d.tenant_id = v_tenant AND lower(d.name) = lower(c.name) AND d.deleted_at IS NULL);
  SELECT id INTO v_co  FROM directory_companies WHERE tenant_id = v_tenant AND name = 'TechCorp Inc';
  SELECT id INTO v_co2 FROM directory_companies WHERE tenant_id = v_tenant AND name = 'Meridian Group';
  SELECT id INTO v_co3 FROM directory_companies WHERE tenant_id = v_tenant AND name = 'Bluewave Analytics';

  -- People (idempotent by email).
  CREATE TEMP TABLE _ppl (fn text, ln text, email text, title text, comp uuid, phone text) ON COMMIT DROP;
  INSERT INTO _ppl VALUES
    ('Amanda','Reyes',  'amanda.reyes@techcorp.io',   'VP Operations', v_co,  '+1 415 555 0134'),
    ('Wei Lin','Tan',   'weilin.tan@bluewave.example','Head of Data',  v_co3, '+65 8123 4455'),
    ('Asha','Rao',      'asha.rao@techcorp.io',       'Head of Sales', v_co,  '+91 98450 12345'),
    ('Rohit','Menon',   'rohit@meridian.example',     'CFO',           v_co2, '+91 99870 22334'),
    ('Priya','Sharma',  'priya@nimbus.example',       'COO',           NULL,  '+91 98111 55667'),
    ('Dave','Okafor',   'dave@northwind.example',     'Procurement',   NULL,  '+971 50 123 4567'),
    ('Sana','Kapoor',   'sana@kavya.example',         'MD',            NULL,  '+91 98430 99887'),
    ('Marco','Silva',   'marco@bluewave.example',     'CTO',           v_co3, '+65 8222 7788');
  INSERT INTO directory_people (tenant_id, first_name, last_name, email, title, company_id, phone, source, created_by)
    SELECT v_tenant, p.fn, p.ln, p.email, p.title, p.comp, p.phone, 'sample', v_owner
    FROM _ppl p
    WHERE NOT EXISTS (SELECT 1 FROM directory_people d WHERE d.tenant_id = v_tenant AND lower(d.email::text) = lower(p.email) AND d.deleted_at IS NULL);
  SELECT id INTO v_p1 FROM directory_people WHERE tenant_id = v_tenant AND email = 'amanda.reyes@techcorp.io';
  SELECT id INTO v_p2 FROM directory_people WHERE tenant_id = v_tenant AND email = 'rohit@meridian.example';

  -- Deals (idempotent by title) — spread across stages, one amber, one red.
  SELECT count(*)::int INTO n FROM deals WHERE tenant_id = v_tenant AND source = 'sample' AND deleted_at IS NULL;
  IF n = 0 THEN
    -- [title, stage idx (1-based), value, currency, fx, days-in-stage, close]
    INSERT INTO deals (tenant_id, pipeline_id, stage_id, title, company_id, primary_person_id, owner_user_id,
                       value_amount, currency, fx_rate_to_base, value_base_amount, expected_close_date,
                       status, source, stage_entered_at, created_by)
    VALUES
      (v_tenant, v_pipeline, s_ids[5], 'TechCorp — Suite rollout',      v_co,  v_p1, v_owner, 42000,  'USD', 83.50, 3507000, CURRENT_DATE + 14, 'open', 'sample', now() - interval '4 days',  v_owner),
      (v_tenant, v_pipeline, s_ids[4], 'Meridian — annual renewal',     v_co2, v_p2, v_owner, 850000, 'INR', 1,     850000,  CURRENT_DATE + 21, 'open', 'sample', now() - interval '12 days', v_owner),
      (v_tenant, v_pipeline, s_ids[3], 'Bluewave — analytics add-on',   v_co3, NULL, v_owner, 12000,  'USD', 83.50, 1002000, CURRENT_DATE + 30, 'open', 'sample', now() - interval '2 days',  v_owner),
      (v_tenant, v_pipeline, s_ids[2], 'Nimbus Retail — POS pilot',     NULL,  NULL, v_owner, 240000, 'INR', 1,     240000,  CURRENT_DATE + 45, 'open', 'sample', now() - interval '1 day',   v_owner),
      (v_tenant, v_pipeline, s_ids[1], 'Kavya Textiles — ERP add-on',   NULL,  NULL, v_owner, 130000, 'INR', 1,     130000,  CURRENT_DATE + 7,  'open', 'sample', now() - interval '16 days', v_owner),
      (v_tenant, v_pipeline, s_ids[1], 'Northwind — wholesale portal',  NULL,  NULL, v_owner, 9500,   'AED', 22.74, 216030,  CURRENT_DATE + 60, 'open', 'sample', now(),                      v_owner),
      (v_tenant, v_pipeline, s_ids[2], 'Sample Co — starter plan',      NULL,  NULL, v_owner, 60000,  'INR', 1,     60000,   CURRENT_DATE + 10, 'open', 'sample', now() - interval '8 days',  v_owner),
      (v_tenant, v_pipeline, s_ids[4], 'Acorn Studios — design retainer', NULL, NULL, v_owner, 3200,  'GBP', 105.70, 338240, CURRENT_DATE + 5,  'open', 'sample', now() - interval '11 days', v_owner);

    -- Opening stage-history rows so every timeline has an entry.
    INSERT INTO deal_stage_history (tenant_id, deal_id, from_stage_id, to_stage_id, changed_by)
      SELECT v_tenant, d.id, NULL, d.stage_id, v_owner FROM deals d
      WHERE d.tenant_id = v_tenant AND d.source = 'sample';

    -- Tags + products + participant on the flagship deal.
    SELECT id INTO v_deal FROM deals WHERE tenant_id = v_tenant AND title = 'TechCorp — Suite rollout';
    INSERT INTO record_tags (tenant_id, tag_id, object_type, object_id) VALUES
      (v_tenant, v_tag_ent, 'deal', v_deal), (v_tenant, v_tag_ren, 'deal', v_deal)
      ON CONFLICT DO NOTHING;
    INSERT INTO deal_products (tenant_id, deal_id, name, quantity, unit_price, currency, discount_pct, line_total, display_order) VALUES
      (v_tenant, v_deal, 'Suite licence — 40 seats',  40, 900,  'USD', 10, 32400, 0),
      (v_tenant, v_deal, 'Implementation package',    1,  8000, 'USD', 0,  8000,  1),
      (v_tenant, v_deal, 'Priority support (yr 1)',   1,  1600, 'USD', 0,  1600,  2);
    INSERT INTO deal_people (tenant_id, deal_id, person_id, role) VALUES
      (v_tenant, v_deal, v_p1, 'decision maker') ON CONFLICT DO NOTHING;
    SELECT id INTO v_deal FROM deals WHERE tenant_id = v_tenant AND title = 'Meridian — annual renewal';
    INSERT INTO record_tags (tenant_id, tag_id, object_type, object_id) VALUES
      (v_tenant, v_tag_ren, 'deal', v_deal) ON CONFLICT DO NOTHING;
    RAISE NOTICE 'Seeded 8 sample deals into pipeline %', v_pipeline;
  ELSE
    RAISE NOTICE 'Sample deals already present (%), skipping deal seed', n;
  END IF;
END
$seed$;
SQL

echo
echo "✔ CRM sample data ready — open CRM → Deals. Everything is tagged source='sample'."
