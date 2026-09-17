// ─── PM shared contracts (PRD v6) ────────────────────────────────────────────
// Consumed by BOTH the API (sync service, mutation executor) and the web
// client (FSE store) — the single source of truth for what syncs and how.

/** Priorities: keyboard 0–4. 0 none · 1 urgent · 2 high · 3 medium · 4 low. */
export const PM_PRIORITIES = [0, 1, 2, 3, 4] as const;
export type PmPriority = (typeof PM_PRIORITIES)[number];
export const PM_PRIORITY_NAMES = ['No priority', 'Urgent', 'High', 'Medium', 'Low'] as const;

/** Workflow-state categories (§4.2) — drive automations, filters, metrics. */
export const PM_STATE_CATEGORIES = [
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
] as const;
export type PmStateCategory = (typeof PM_STATE_CATEGORIES)[number];

export const PM_ESTIMATE_SCALES = ['count', 'linear', 'fibonacci', 'exponential', 'tshirt'] as const;
export type PmEstimateScale = (typeof PM_ESTIMATE_SCALES)[number];

export const PM_ISSUE_SOURCES = ['manual', 'import', 'api', 'github', 'intake', 'deal'] as const;
export const PM_RELATION_TYPES = ['blocks', 'duplicate_of', 'relates_to'] as const;

/** Project lifecycle + health (§6.1/§6.3). */
export const PM_PROJECT_STATUSES = [
  'backlog',
  'planned',
  'in_progress',
  'paused',
  'completed',
  'canceled',
] as const;
export type PmProjectStatus = (typeof PM_PROJECT_STATUSES)[number];
export const PM_PROJECT_HEALTH = ['on_track', 'at_risk', 'off_track'] as const;
export type PmProjectHealth = (typeof PM_PROJECT_HEALTH)[number];
export const PM_INITIATIVE_STATUSES = ['active', 'completed', 'paused'] as const;

// ─── Round M — project Insights panel, project priority, update snapshots ────

export const PM_INSIGHT_MEASURES = ['count', 'points'] as const
export type PmInsightMeasure = (typeof PM_INSIGHT_MEASURES)[number]
export const PM_INSIGHT_SLICES = ['status', 'priority', 'assignee', 'milestone', 'label'] as const
export type PmInsightSlice = (typeof PM_INSIGHT_SLICES)[number]
export const PM_INSIGHT_SEGMENTS = ['none', 'priority', 'status', 'assignee'] as const
export type PmInsightSegment = (typeof PM_INSIGHT_SEGMENTS)[number]
export interface PmInsightsConfig { measure: PmInsightMeasure; slice: PmInsightSlice; segment: PmInsightSegment }
export const PM_INSIGHTS_DEFAULT: PmInsightsConfig = { measure: 'count', slice: 'status', segment: 'priority' }
// The Insights / Progress-graph math (pivot, weekly series, prediction) —
// shared by the API payload and the web's sync-mode computation.
export * from './insights'

/** Project priority uses the issue scale: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
export const PM_PROJECT_PRIORITY_MAX = 4

export interface PmUpdateSnapshotMilestone { id: string; name: string; target_date: string | null; scope: number; done: number; pct: number; completed_at: string | null }
export interface PmUpdateSnapshot {
  v: 1
  at: string
  progress: { scope: number; started: number; done: number }
  issues_done: number
  props: { status: string; priority: number; lead_user_id: string | null; start_date: string | null; target_date: string | null; health: string | null }
  milestones: PmUpdateSnapshotMilestone[]
}
export type PmUpdateDiffPropKey = 'status' | 'priority' | 'lead_user_id' | 'start_date' | 'target_date'
export interface PmUpdateDiffProp { key: PmUpdateDiffPropKey; from: string | number | null; to: string | number | null }
export interface PmUpdateDiffMilestone { id: string; name: string; from_pct: number; to_pct: number; completed_at: string | null }
export interface PmUpdateDiff { since: string; props: PmUpdateDiffProp[]; milestones: PmUpdateDiffMilestone[]; issues_done_delta: number }
// Read-time diff of two snapshots (API detail + web sync mode share it).
export { diffProjectUpdate, baselineSnapshot, isUpdateSnapshot, PM_UPDATE_DIFF_PROP_KEYS } from './update-diff'

/**
 * Sync-table registry (§3.3/§3.4): the ONLY tables the FSE ships to clients,
 * with the columns each row snapshot carries. `pm_issues` deliberately omits
 * `description` (lazy-loaded on open) — the registry is the projection.
 * Table names here appear in delta `{upserts,tombstones}` keys and in the
 * client's IndexedDB store names — treat as a wire contract.
 */
export const PM_SYNC_TABLES = {
  pm_teams: [
    'id', 'key', 'name', 'icon', 'color', 'is_private', 'timezone',
    'cycles_enabled', 'cycle_length_weeks', 'cooldown_days', 'cycle_start_dow',
    'cycle_auto_add_started', 'upcoming_cycles', 'estimate_scale',
    'triage_enabled', 'default_state_id', 'created_at', 'deleted_at',
  ],
  pm_team_memberships: ['team_id', 'user_id', 'is_lead', 'joined_at'],
  pm_workflow_states: [
    'id', 'team_id', 'name', 'color', 'category', 'position', 'is_default_for_category',
  ],
  pm_labels: ['id', 'team_id', 'name', 'color', 'description'],
  pm_issues: [
    'id', 'team_id', 'number', 'title', 'state_id', 'priority', 'estimate',
    'assignee_user_id', 'creator_user_id', 'parent_issue_id', 'project_id',
    'milestone_id', 'cycle_id', 'due_date', 'board_rank', 'backlog_rank',
    'source', 'triaged_at', 'snoozed_until', 'started_at', 'completed_at', 'canceled_at',
    'created_at', 'updated_at', 'deleted_at',
  ],
  pm_issue_labels: ['issue_id', 'label_id'],
  pm_issue_relations: ['id', 'issue_id', 'related_issue_id', 'type'],
  pm_issue_subscribers: ['issue_id', 'user_id'],
  // Projects layer (0042). pm_projects omits description_md (lazy, like issues).
  // Round E: is_private (members-only visibility) + logo_url — the SIGNED
  // serving URL, never the raw storage key (the emoji icon is the fallback
  // when a persisted signature has aged out).
  // Round M: priority (issue scale) + insights_default (saved Insights config).
  pm_projects: [
    'id', 'name', 'summary', 'icon', 'color', 'status', 'health', 'priority',
    'insights_default', 'is_private', 'logo_url', 'lead_user_id', 'start_date',
    'target_date', 'deal_id', 'completed_at', 'created_at', 'updated_at', 'deleted_at',
  ],
  pm_project_teams: ['project_id', 'team_id'],
  pm_project_members: ['project_id', 'user_id'],
  pm_project_milestones: ['id', 'project_id', 'name', 'description_md', 'target_date', 'position', 'created_at'],
  // Updates: bootstrap ships the latest 10 per project; deltas upsert per row.
  // Round M: snapshot — the project state captured at post time (PmUpdateSnapshot).
  pm_project_updates: ['id', 'project_id', 'health', 'body_md', 'author_user_id', 'snapshot', 'created_at'],
  pm_initiatives: [
    'id', 'name', 'description', 'status', 'owner_user_id', 'target_quarter',
    'created_at', 'updated_at', 'deleted_at',
  ],
  pm_initiative_projects: ['initiative_id', 'project_id', 'position'],
  // Cycles (0043). Bootstrap ships current ± upcoming per team.
  pm_cycles: ['id', 'team_id', 'number', 'starts_at', 'ends_at', 'cooldown_ends_at', 'status', 'created_at'],
} as const;
export type PmSyncTable = keyof typeof PM_SYNC_TABLES;
export const PM_SYNC_TABLE_NAMES = Object.keys(PM_SYNC_TABLES) as PmSyncTable[];

/**
 * Mutation ops (§3.5). CRUD ops carry {table, id, fields}; named ops carry
 * {args}. The server-side executor maps each op to a domain-service method —
 * client checks are UX only, the server re-validates everything.
 */
export const PM_MUTATION_OPS = [
  'issue.create',
  'issue.update',          // title/description/estimate/due_date/labels via fields
  'issue.move_state',
  'issue.set_priority',
  'issue.assign',
  'issue.rank',            // {rank_field: 'board_rank'|'backlog_rank', rank}
  'issue.set_labels',
  'issue.relate',
  'issue.unrelate',
  'issue.subscribe',
  'issue.unsubscribe',
  'issue.delete',
  'issue.restore',
  'issue.move_team',
  'issue.set_project',     // {project_id: uuid|null, milestone_id?: uuid|null}
  'comment.create',
  // Projects layer (§6)
  'project.create',
  'project.update',        // name/summary/icon/color/status/dates/lead via fields
  'project.set_teams',     // {team_ids: uuid[]}
  'project.post_update',   // {health, body_md} → pm_project_updates + denormalized health
  'project.delete',
  'project.restore',
  'milestone.create',      // {project_id, name, target_date?, position?}
  'milestone.update',
  'milestone.delete',
  'initiative.create',
  'initiative.update',
  'initiative.set_projects', // {project_ids: uuid[]}
  // Cycles + triage (§7/§8)
  'issue.set_cycle',        // {cycle_id: uuid|null}
  'issue.send_to_triage',   // Shift+T
  'issue.triage_accept',    // {priority?, assignee_user_id?} → default state + triaged_at
  'issue.triage_decline',   // {reason?} → Canceled
  'issue.snooze',           // {until: iso|null}
] as const;
export type PmMutationOp = (typeof PM_MUTATION_OPS)[number];

export interface PmMutationItem {
  clientMutationId: string; // uuid minted by the client; idempotency key
  op: PmMutationOp;
  /** Target row id (client-minted uuid for creates). */
  id: string;
  /** Field patch for CRUD ops; named-op args otherwise. */
  fields?: Record<string, unknown>;
}

export interface PmMutationResultItem {
  clientMutationId: string;
  status: 'applied' | 'rejected' | 'conflict' | 'duplicate';
  errorCode?: string;
  /** Authoritative row snapshots touched by this item, keyed by table. */
  rows?: Partial<Record<PmSyncTable, Record<string, unknown>[]>>;
}

export const PM_MUTATE_BATCH_CAP = 500;
export const PM_MUTATE_RATE_PER_MIN = 120;

// ─── LexoRank-lite (§5.1 board_rank/backlog_rank) ────────────────────────────
// Fractional indexing over a base-36 alphabet. rankBetween(a, b) returns a key
// strictly between its arguments; rankBetween(null, first) prepends,
// rankBetween(last, null) appends. Keys grow only when repeatedly inserting
// into the same gap; periodic rebalance is the caller's concern.
// INVARIANT: generated keys never end in '0' (the emitted midpoint digit is
// always ≥ low+1), which guarantees no key is another key + a '0' suffix — the
// one shape this algorithm cannot split. Seed/import ranks MUST come from
// rankSpread()/rankBetween(), never hand-written strings. Precondition: a < b.

const RANK_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const RANK_MIN = '0';
const RANK_MAX = 'z';

function charVal(c: string): number {
  return RANK_ALPHABET.indexOf(c);
}

/** Midpoint key strictly between a and b (lexicographic, base-36). */
export function rankBetween(a: string | null, b: string | null): string {
  const lo = a ?? '';
  const hi = b ?? '';
  let prefix = '';
  let i = 0;
  // Walk the shared region until we find room for a midpoint digit.
  for (;;) {
    const cl = i < lo.length ? charVal(lo[i]!) : 0;                     // implicit '0' padding
    const ch = i < hi.length ? charVal(hi[i]!) : RANK_ALPHABET.length;  // implicit past-'z' ceiling
    if (ch - cl > 1) {
      return prefix + RANK_ALPHABET[Math.floor((cl + ch) / 2)]!;
    }
    // No room at this digit: keep the low digit and descend.
    prefix += RANK_ALPHABET[cl]!;
    i++;
    // Guard: if lo is a prefix of hi with no gap anywhere, extend lo's tail.
    if (i > Math.max(lo.length, hi.length) + 32) {
      return prefix + 'i'; // unreachable in practice; deterministic fallback
    }
  }
}

/** Initial rank for the first row in an empty list. */
export function rankInitial(): string {
  return 'i'; // middle of the alphabet — room both ways
}

/** Evenly spaced ranks for seeding/rebalancing n rows. */
export function rankSpread(n: number): string[] {
  const out: string[] = [];
  let prev: string | null = null;
  for (let k = 0; k < n; k++) {
    prev = rankBetween(prev, null);
    out.push(prev);
  }
  return out;
}

export { RANK_MIN, RANK_MAX };
