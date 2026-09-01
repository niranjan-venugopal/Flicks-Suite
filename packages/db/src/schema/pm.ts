import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  integer,
  smallint,
  bigint,
  numeric,
  real,
  date,
  index,
  uniqueIndex,
  primaryKey,
  jsonb,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants, users } from './platform';

// ─── PM — Projects module (PRD v6) ────────────────────────────────────────────
// Workspace = tenant; work happens in teams. Everything here syncs through the
// Flicks Sync Engine (bootstrap/delta/mutate over the domain_events outbox).
// All tables FORCE RLS with the standard tenant policy (migrations 0039–0041).
// Search columns (search_tsv) are DB-generated — never written by the app.

// ─── sync_mutations — FSE idempotency ledger (0039) ──────────────────────────

export const syncMutations = pgTable(
  'sync_mutations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    client_mutation_id: uuid('client_mutation_id').notNull(),
    result_seq: bigint('result_seq', { mode: 'number' }),
    status: text('status').notNull(), // applied | rejected | conflict
    error_code: text('error_code'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sync_mutations_tenant_id_user_id_client_mutation_id_key').on(
      t.tenant_id,
      t.user_id,
      t.client_mutation_id,
    ),
    index('idx_sync_mutations_prune').on(t.created_at),
  ],
);

// ─── Teams (0040) ────────────────────────────────────────────────────────────

export const pmTeams = pgTable(
  'pm_teams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 6 }).notNull(), // "ENG" → ENG-123
    name: text('name').notNull(),
    icon: text('icon'),
    color: text('color'),
    is_private: boolean('is_private').notNull().default(false),
    timezone: text('timezone'), // cycle boundaries; NULL = tenant tz
    cycles_enabled: boolean('cycles_enabled').notNull().default(false),
    cycle_length_weeks: smallint('cycle_length_weeks').notNull().default(2),
    cooldown_days: smallint('cooldown_days').notNull().default(0),
    cycle_start_dow: smallint('cycle_start_dow').notNull().default(1),
    cycle_auto_add_started: boolean('cycle_auto_add_started').notNull().default(true),
    upcoming_cycles: smallint('upcoming_cycles').notNull().default(2),
    estimate_scale: text('estimate_scale').notNull().default('count'),
    triage_enabled: boolean('triage_enabled').notNull().default(true),
    // GitHub status automations (0046, P16) — on by default; bot comment off.
    gh_auto_branch: boolean('gh_auto_branch').notNull().default(true),
    gh_auto_pr_open: boolean('gh_auto_pr_open').notNull().default(true),
    gh_auto_pr_merge: boolean('gh_auto_pr_merge').notNull().default(true),
    gh_auto_pr_close: boolean('gh_auto_pr_close').notNull().default(true),
    gh_magic_words: boolean('gh_magic_words').notNull().default(true),
    gh_bot_comment: boolean('gh_bot_comment').notNull().default(false),
    default_state_id: uuid('default_state_id'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('pm_teams_tenant_id_key_key').on(t.tenant_id, t.key),
    index('idx_pm_teams_tenant')
      .on(t.tenant_id)
      .where(sql`${t.deleted_at} IS NULL`),
  ],
);

export const pmTeamMemberships = pgTable(
  'pm_team_memberships',
  {
    team_id: uuid('team_id')
      .notNull()
      .references(() => pmTeams.id, { onDelete: 'cascade' }),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    is_lead: boolean('is_lead').notNull().default(false),
    joined_at: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.team_id, t.user_id] }),
    index('idx_pm_team_memberships_user').on(t.tenant_id, t.user_id),
  ],
);

export const pmTeamCounters = pgTable('pm_team_counters', {
  team_id: uuid('team_id')
    .primaryKey()
    .references(() => pmTeams.id, { onDelete: 'cascade' }),
  tenant_id: uuid('tenant_id').notNull(),
  last_number: integer('last_number').notNull().default(0),
});

export const pmWorkflowStates = pgTable(
  'pm_workflow_states',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    team_id: uuid('team_id')
      .notNull()
      .references(() => pmTeams.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull(),
    category: text('category').notNull(), // triage|backlog|unstarted|started|completed|canceled
    position: real('position').notNull(),
    is_default_for_category: boolean('is_default_for_category').notNull().default(false),
  },
  (t) => [
    uniqueIndex('pm_workflow_states_tenant_id_team_id_name_key').on(t.tenant_id, t.team_id, t.name),
    index('idx_pm_states_team').on(t.tenant_id, t.team_id),
  ],
);

export const pmLabels = pgTable(
  'pm_labels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    team_id: uuid('team_id').references(() => pmTeams.id, { onDelete: 'cascade' }), // NULL = workspace
    name: text('name').notNull(),
    color: text('color').notNull(),
    description: text('description'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_pm_labels_scope').on(
      t.tenant_id,
      sql`coalesce(${t.team_id}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.name,
    ),
  ],
);

// ─── Issues (0041) ───────────────────────────────────────────────────────────

export const pmIssues = pgTable(
  'pm_issues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    team_id: uuid('team_id')
      .notNull()
      .references(() => pmTeams.id),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    description: text('description'), // markdown; lazy-loaded by sync
    state_id: uuid('state_id')
      .notNull()
      .references(() => pmWorkflowStates.id),
    priority: smallint('priority').notNull().default(0), // 0 none · 1 urgent … 4 low
    estimate: numeric('estimate', { precision: 6, scale: 2 }),
    assignee_user_id: uuid('assignee_user_id').references(() => users.id),
    creator_user_id: uuid('creator_user_id').references(() => users.id),
    parent_issue_id: uuid('parent_issue_id'), // self-FK in SQL
    project_id: uuid('project_id'), // FK added in 0042
    milestone_id: uuid('milestone_id'),
    cycle_id: uuid('cycle_id'), // FK added in 0043
    snoozed_until: timestamp('snoozed_until', { withTimezone: true }), // triage Z (0043)
    import_batch_id: uuid('import_batch_id'), // §14 — undo retracts by batch (0047)
    external_ref: text('external_ref'), // '<source>:<id>' idempotent re-import (0047)
    due_date: date('due_date'),
    board_rank: text('board_rank').notNull(), // fractional index (LexoRank-lite)
    backlog_rank: text('backlog_rank').notNull(),
    source: text('source').notNull().default('manual'),
    triaged_at: timestamp('triaged_at', { withTimezone: true }),
    started_at: timestamp('started_at', { withTimezone: true }),
    completed_at: timestamp('completed_at', { withTimezone: true }),
    canceled_at: timestamp('canceled_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
    // 0056 — set when this issue was deleted BY its project's delete, not on
    // its own. Restore un-deletes exactly this set, so an issue the user had
    // already deleted by hand stays deleted when the project comes back. No FK
    // on purpose: see the migration.
    deleted_with_project_id: uuid('deleted_with_project_id'),
  },
  (t) => [
    uniqueIndex('pm_issues_tenant_id_team_id_number_key').on(t.tenant_id, t.team_id, t.number),
    index('idx_issues_team_state')
      .on(t.tenant_id, t.team_id, t.state_id)
      .where(sql`${t.deleted_at} IS NULL`),
    index('idx_issues_assignee')
      .on(t.tenant_id, t.assignee_user_id)
      .where(sql`${t.deleted_at} IS NULL`),
    index('idx_issues_cycle').on(t.tenant_id, t.cycle_id),
    index('idx_issues_project').on(t.tenant_id, t.project_id),
    // 0059 — bootstrap + REST list both ORDER BY updated_at DESC per team.
    index('idx_issues_team_updated')
      .on(t.tenant_id, t.team_id, t.updated_at.desc())
      .where(sql`${t.deleted_at} IS NULL`),
    index('idx_issues_parent').on(t.parent_issue_id),
    index('idx_pm_issues_deleted_with_project')
      .on(t.tenant_id, t.deleted_with_project_id)
      .where(sql`${t.deleted_with_project_id} IS NOT NULL`),
  ],
);

export const pmIssueLabels = pgTable(
  'pm_issue_labels',
  {
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    issue_id: uuid('issue_id')
      .notNull()
      .references(() => pmIssues.id, { onDelete: 'cascade' }),
    label_id: uuid('label_id')
      .notNull()
      .references(() => pmLabels.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.issue_id, t.label_id] }),
    index('idx_pm_issue_labels_label').on(t.tenant_id, t.label_id),
  ],
);

export const pmIssueRelations = pgTable(
  'pm_issue_relations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    issue_id: uuid('issue_id')
      .notNull()
      .references(() => pmIssues.id, { onDelete: 'cascade' }),
    related_issue_id: uuid('related_issue_id')
      .notNull()
      .references(() => pmIssues.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // blocks | duplicate_of | relates_to
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('pm_issue_relations_tenant_id_issue_id_related_issue_id_type_key').on(
      t.tenant_id,
      t.issue_id,
      t.related_issue_id,
      t.type,
    ),
    index('idx_pm_relations_related').on(t.tenant_id, t.related_issue_id),
  ],
);

export const pmIssueSubscribers = pgTable(
  'pm_issue_subscribers',
  {
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    issue_id: uuid('issue_id')
      .notNull()
      .references(() => pmIssues.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.issue_id, t.user_id] }),
    index('idx_pm_subscribers_user').on(t.tenant_id, t.user_id),
  ],
);

export const pmIssueComments = pgTable(
  'pm_issue_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    issue_id: uuid('issue_id')
      .notNull()
      .references(() => pmIssues.id, { onDelete: 'cascade' }),
    author_user_id: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    parent_comment_id: uuid('parent_comment_id'), // one level; self-FK in SQL
    body: text('body').notNull(), // markdown
    edited_at: timestamp('edited_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('idx_pm_comments_issue').on(t.tenant_id, t.issue_id, t.created_at)],
);

export const pmCommentReactions = pgTable(
  'pm_comment_reactions',
  {
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    comment_id: uuid('comment_id')
      .notNull()
      .references(() => pmIssueComments.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.comment_id, t.user_id, t.emoji] })],
);

export const pmIssueHistory = pgTable(
  'pm_issue_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    issue_id: uuid('issue_id')
      .notNull()
      .references(() => pmIssues.id, { onDelete: 'cascade' }),
    field: text('field').notNull(),
    from_value: text('from_value'),
    to_value: text('to_value'),
    actor_user_id: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_pm_history_issue').on(t.tenant_id, t.issue_id, t.created_at)],
);

// ─── Templates + view favorites (0044) ───────────────────────────────────────

export const pmIssueTemplates = pgTable(
  'pm_issue_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    team_id: uuid('team_id')
      .notNull()
      .references(() => pmTeams.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    title_pattern: text('title_pattern'),
    description_md: text('description_md'),
    default_priority: smallint('default_priority'),
    default_estimate: numeric('default_estimate', { precision: 6, scale: 2 }),
    default_state_id: uuid('default_state_id'),
    default_label_ids: uuid('default_label_ids').array().notNull().default([]),
    is_team_default: boolean('is_team_default').notNull().default(false),
    schedule: text('schedule'), // reserved: recurring issues (v1.5)
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('pm_issue_templates_tenant_id_team_id_name_key').on(t.tenant_id, t.team_id, t.name)],
);

export const pmProjectTemplates = pgTable(
  'pm_project_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description_md: text('description_md'),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('pm_project_templates_tenant_id_name_key').on(t.tenant_id, t.name)],
);

export const pmProjectTemplateItems = pgTable('pm_project_template_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  template_id: uuid('template_id')
    .notNull()
    .references(() => pmProjectTemplates.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description_md: text('description_md'),
  default_priority: smallint('default_priority'),
  relative_due_days: integer('relative_due_days'),
  position: smallint('position').notNull().default(0),
});

export const pmViewFavorites = pgTable(
  'pm_view_favorites',
  {
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    view_id: uuid('view_id').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.view_id] }),
    index('idx_pm_view_favorites_user').on(t.tenant_id, t.user_id),
  ],
);

// ─── Projects, milestones, updates, initiatives (0042) ───────────────────────

export const pmProjects = pgTable(
  'pm_projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    summary: text('summary'),
    description_md: text('description_md'), // lazy-loaded (not in sync projection)
    icon: text('icon'),
    color: text('color'),
    status: text('status').notNull().default('planned'), // backlog|planned|in_progress|paused|completed|canceled
    health: text('health').notNull().default('on_track'), // denormalized latest; pm_project_updates is the log
    // 0059 — opt-in: visible only to members + lead + full-access roles.
    is_private: boolean('is_private').notNull().default(false),
    // 0059 — uploaded logo (R2 WebP variants); raw key never serialized out.
    logo_key: text('logo_key'),
    logo_updated_at: timestamp('logo_updated_at', { withTimezone: true }),
    lead_user_id: uuid('lead_user_id').references(() => users.id, { onDelete: 'set null' }),
    start_date: date('start_date'),
    target_date: date('target_date'),
    deal_id: uuid('deal_id'), // CRM back-link (§15.2); no FK — module boundary
    import_batch_id: uuid('import_batch_id'), // §14 (0047)
    external_ref: text('external_ref'), // §14 (0047)
    completed_at: timestamp('completed_at', { withTimezone: true }),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_pm_projects_deal').on(t.tenant_id, t.deal_id),
    // 0059 — visibility scoping reads the live project set on every request.
    index('idx_pm_projects_tenant_live').on(t.tenant_id).where(sql`${t.deleted_at} IS NULL`),
  ],
);

export const pmProjectTeams = pgTable(
  'pm_project_teams',
  {
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    project_id: uuid('project_id')
      .notNull()
      .references(() => pmProjects.id, { onDelete: 'cascade' }),
    team_id: uuid('team_id')
      .notNull()
      .references(() => pmTeams.id, { onDelete: 'cascade' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.project_id, t.team_id] }),
    index('idx_pm_project_teams_team').on(t.tenant_id, t.team_id),
  ],
);

export const pmProjectMembers = pgTable(
  'pm_project_members',
  {
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    project_id: uuid('project_id')
      .notNull()
      .references(() => pmProjects.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.project_id, t.user_id] }),
    // Guest visibility walks this table by (tenant, user) — 0051.
    index('idx_pm_project_members_user').on(t.tenant_id, t.user_id),
  ],
);

export const pmProjectMilestones = pgTable(
  'pm_project_milestones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    project_id: uuid('project_id')
      .notNull()
      .references(() => pmProjects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    target_date: date('target_date'),
    position: smallint('position').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_pm_milestones_project').on(t.tenant_id, t.project_id)],
);

export const pmProjectUpdates = pgTable(
  'pm_project_updates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    project_id: uuid('project_id')
      .notNull()
      .references(() => pmProjects.id, { onDelete: 'cascade' }),
    health: text('health').notNull(), // on_track|at_risk|off_track
    body_md: text('body_md').notNull(),
    author_user_id: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_pm_updates_project').on(t.tenant_id, t.project_id, t.created_at)],
);

export const pmInitiatives = pgTable('pm_initiatives', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  status: text('status').notNull().default('active'), // active|completed|paused
  owner_user_id: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
  target_quarter: text('target_quarter'), // 'Q3 2026'
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deleted_at: timestamp('deleted_at', { withTimezone: true }),
});

export const pmInitiativeProjects = pgTable(
  'pm_initiative_projects',
  {
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    initiative_id: uuid('initiative_id')
      .notNull()
      .references(() => pmInitiatives.id, { onDelete: 'cascade' }),
    project_id: uuid('project_id')
      .notNull()
      .references(() => pmProjects.id, { onDelete: 'cascade' }),
    position: smallint('position').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.initiative_id, t.project_id] })],
);

// ─── Cycles + snapshots (0043) ───────────────────────────────────────────────

export const pmCycles = pgTable(
  'pm_cycles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    team_id: uuid('team_id')
      .notNull()
      .references(() => pmTeams.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    starts_at: timestamp('starts_at', { withTimezone: true }).notNull(),
    ends_at: timestamp('ends_at', { withTimezone: true }).notNull(),
    cooldown_ends_at: timestamp('cooldown_ends_at', { withTimezone: true }).notNull(),
    status: text('status').notNull().default('upcoming'), // upcoming|active|completed
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('pm_cycles_team_id_number_key').on(t.team_id, t.number),
    index('idx_pm_cycles_team').on(t.tenant_id, t.team_id, t.starts_at),
  ],
);

export const pmCycleSnapshots = pgTable(
  'pm_cycle_snapshots',
  {
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    cycle_id: uuid('cycle_id')
      .notNull()
      .references(() => pmCycles.id, { onDelete: 'cascade' }),
    snapshot_date: date('snapshot_date').notNull(),
    scope_points: numeric('scope_points', { precision: 10, scale: 2 }).notNull().default('0'),
    started_points: numeric('started_points', { precision: 10, scale: 2 }).notNull().default('0'),
    completed_points: numeric('completed_points', { precision: 10, scale: 2 }).notNull().default('0'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.cycle_id, t.snapshot_date] })],
);

export const pmSamplePacks = pgTable('pm_sample_packs', {
  tenant_id: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  record_ids: jsonb('record_ids').notNull().default({}), // {table: [ids]}
  created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── GitHub integration (0046, §12) ──────────────────────────────────────────

export const pmGithubInstallations = pgTable('pm_github_installations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: uuid('tenant_id')
    .notNull()
    .unique()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  installation_id: bigint('installation_id', { mode: 'number' }).notNull().unique(),
  account_login: text('account_login').notNull(),
  branch_format: text('branch_format')
    .notNull()
    .default('{user}/{team-key-lower}-{number}-{slug}'),
  status: text('status').notNull().default('active'), // 'active' | 'error'
  failed_deliveries: integer('failed_deliveries').notNull().default(0),
  last_delivery_status: integer('last_delivery_status'),
  last_delivery_at: timestamp('last_delivery_at', { withTimezone: true }),
  created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pmGithubRepos = pgTable(
  'pm_github_repos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    installation_id: bigint('installation_id', { mode: 'number' }).notNull(),
    repo_id: bigint('repo_id', { mode: 'number' }),
    repo_full_name: text('repo_full_name').notNull(),
    team_id: uuid('team_id')
      .notNull()
      .references(() => pmTeams.id, { onDelete: 'cascade' }),
    autolink: boolean('autolink').notNull().default(true),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('pm_github_repos_tenant_id_repo_full_name_key').on(t.tenant_id, t.repo_full_name),
    index('idx_pm_github_repos_team').on(t.tenant_id, t.team_id),
  ],
);

export const pmIssueGitLinks = pgTable(
  'pm_issue_git_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    issue_id: uuid('issue_id')
      .notNull()
      .references(() => pmIssues.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // 'branch' | 'pr' | 'commit'
    ref: text('ref').notNull(), // branch name / PR number / short sha
    label: text('label').notNull(),
    state: text('state').notNull().default('open'), // 'open' | 'merged' | 'closed'
    url: text('url'),
    repo_full_name: text('repo_full_name'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('pm_issue_git_links_tenant_id_issue_id_kind_ref_key').on(
      t.tenant_id,
      t.issue_id,
      t.kind,
      t.ref,
    ),
    index('idx_pm_issue_git_links_issue').on(t.tenant_id, t.issue_id),
  ],
);

// Delivery-id idempotency ledger — service-role only (see 0046 RLS).
export const githubWebhookEvents = pgTable(
  'github_webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    delivery_id: text('delivery_id').notNull().unique(),
    event: text('event').notNull(),
    action: text('action'),
    installation_id: bigint('installation_id', { mode: 'number' }),
    tenant_id: uuid('tenant_id'),
    signature_verified: boolean('signature_verified').notNull().default(false),
    processed: boolean('processed').notNull().default(false),
    processed_at: timestamp('processed_at', { withTimezone: true }),
    processing_error: text('processing_error'),
    payload: jsonb('payload'),
    received_at: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_github_webhook_events_pending')
      .on(t.received_at)
      .where(sql`${t.signature_verified} AND NOT ${t.processed}`),
  ],
);

// ─── Types ───────────────────────────────────────────────────────────────────

export type SyncMutation = typeof syncMutations.$inferSelect;
export type PmTeam = typeof pmTeams.$inferSelect;
export type NewPmTeam = typeof pmTeams.$inferInsert;
export type PmTeamMembership = typeof pmTeamMemberships.$inferSelect;
export type PmWorkflowState = typeof pmWorkflowStates.$inferSelect;
export type PmLabel = typeof pmLabels.$inferSelect;
export type PmIssue = typeof pmIssues.$inferSelect;
export type NewPmIssue = typeof pmIssues.$inferInsert;
export type PmIssueComment = typeof pmIssueComments.$inferSelect;
export type PmIssueHistoryRow = typeof pmIssueHistory.$inferSelect;
export type PmProject = typeof pmProjects.$inferSelect;
export type NewPmProject = typeof pmProjects.$inferInsert;
export type PmProjectMilestone = typeof pmProjectMilestones.$inferSelect;
export type PmProjectUpdate = typeof pmProjectUpdates.$inferSelect;
export type PmInitiative = typeof pmInitiatives.$inferSelect;
export type PmCycle = typeof pmCycles.$inferSelect;
export type PmCycleSnapshot = typeof pmCycleSnapshots.$inferSelect;
