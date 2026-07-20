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
    cycle_id: uuid('cycle_id'),
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
    index('idx_issues_parent').on(t.parent_issue_id),
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
