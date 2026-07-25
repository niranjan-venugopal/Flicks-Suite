import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { db, dbAdmin } from '@flicks/db';
import {
  tenants,
  users,
  memberships,
  pmTeams,
  pmWorkflowStates,
  pmIssues,
  pmIssueGitLinks,
  pmIssueHistory,
  githubWebhookEvents,
  notifications,
  domainEvents,
} from '@flicks/db/schema';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { DomainEventsService } from '../core/events/domain-events.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { PmTeamsService } from '../modules/pm/teams.service';
import { PmIssuesService } from '../modules/pm/issues.service';
import { GithubAppService } from '../modules/pm/github-app.service';
import { PmGithubService } from '../modules/pm/github.service';

/**
 * PRD v6 Sprint 39 — GitHub integration on GOLDEN FIXTURES (no live App):
 * signature verify (timing-safe reject), delivery-id idempotency, the E2E
 * chain branch→PR→merge walking an issue Todo→In Progress→In Review→Done
 * with history + inbox, close-unmerged revert, magic words, and the
 * cross-tenant isolation class (installation A can never link tenant B).
 */

const SECRET = 'test-webhook-secret';
process.env.GITHUB_WEBHOOK_SECRET = SECRET;

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const emitter = new EventEmitter2();
const domainEventsSvc = new DomainEventsService(dbAdmin as never, emitter);
const config = new ConfigService();
const notificationsSvc = new NotificationsService(db as never, dbAdmin as never, config, emitter);
const teamsSvc = new PmTeamsService(dbSvc, audit, domainEventsSvc);
const issuesSvc = new PmIssuesService(dbSvc, audit, domainEventsSvc, notificationsSvc);
const appSvc = new GithubAppService(config); // unconfigured — API calls no-op
const github = new PmGithubService(
  dbSvc,
  dbAdmin as never,
  config,
  audit,
  domainEventsSvc,
  notificationsSvc,
  issuesSvc,
  appSvc,
);

let tenantId: string;
let ownerId: string;
let teamId: string;
let teamKey: string;
const INSTALLATION_ID = 100000000 + Math.floor(Math.random() * 800000000);
const REPO = 'specflicks/flicks-suite';

let deliverySeq = 0;
function deliver(event: string, payload: Record<string, unknown>, opts?: { badSig?: boolean; deliveryId?: string }) {
  const withInstallation = { installation: { id: INSTALLATION_ID }, repository: { full_name: REPO }, ...payload };
  const rawBody = Buffer.from(JSON.stringify(withInstallation));
  const signature = opts?.badSig
    ? 'sha256=' + '0'.repeat(64)
    : 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
  return github.handleDelivery({
    deliveryId: opts?.deliveryId ?? `dlv-${rid()}-${deliverySeq++}`,
    event,
    signature,
    rawBody,
    payload: withInstallation,
  });
}

const stateOf = async (issueId: string) => {
  const [issue] = await dbAdmin.select().from(pmIssues).where(eq(pmIssues.id, issueId));
  const [state] = await dbAdmin.select().from(pmWorkflowStates).where(eq(pmWorkflowStates.id, issue!.state_id));
  return state!;
};
const linksOf = (issueId: string) =>
  dbAdmin.select().from(pmIssueGitLinks).where(eq(pmIssueGitLinks.issue_id, issueId));

// Automations run through the real moveState → fire-and-forget notifications;
// give them a beat to land.
const settle = () => new Promise((r) => setTimeout(r, 250));

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `GH Studio ${rid()}`, slug: `gh-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  tenantId = t!.id;
  const [u] = await dbAdmin
    .insert(users)
    .values({ email: `gh-owner-${rid()}@t.test`, full_name: 'GH Owner', status: 'active' })
    .returning();
  ownerId = u!.id;
  await dbAdmin.insert(memberships).values({ tenant_id: tenantId, user_id: ownerId, role: 'owner', status: 'active' });
  await teamsSvc.ensureWorkspace(tenantId, ownerId);
  const [team] = await dbAdmin.select().from(pmTeams).where(eq(pmTeams.tenant_id, tenantId));
  teamId = team!.id;
  teamKey = team!.key;

  await github.claimInstallation(tenantId, ownerId, { installation_id: INSTALLATION_ID, account_login: 'specflicks' });
  await github.mapRepo(tenantId, ownerId, { repo_full_name: REPO, team_id: teamId });
});

afterAll(async () => {
  await dbAdmin.delete(githubWebhookEvents).where(eq(githubWebhookEvents.installation_id, INSTALLATION_ID));
  await dbAdmin.delete(domainEvents).where(eq(domainEvents.tenant_id, tenantId));
  await dbAdmin.delete(notifications).where(eq(notifications.user_id, ownerId));
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  await dbAdmin.delete(users).where(eq(users.id, ownerId));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('GitHub webhook — verification + idempotency (§12.2)', () => {
  it('rejects a bad X-Hub-Signature-256 with 401 and stores nothing', async () => {
    await expect(deliver('create', { ref: 'x/nothing', ref_type: 'branch' }, { badSig: true })).rejects.toThrow(
      /Invalid X-Hub-Signature-256/,
    );
    const rows = await dbAdmin
      .select()
      .from(githubWebhookEvents)
      .where(eq(githubWebhookEvents.installation_id, INSTALLATION_ID));
    expect(rows).toHaveLength(0);
  });

  it('replays of the same delivery id are no-ops', async () => {
    const issue = (await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: 'Idempotency probe' })).data;
    const id = `dlv-fixed-${rid()}`;
    const first = await deliver('create', { ref: `dev/${teamKey.toLowerCase()}-${issue.number}-probe`, ref_type: 'branch' }, { deliveryId: id });
    const second = await deliver('create', { ref: `dev/${teamKey.toLowerCase()}-${issue.number}-probe`, ref_type: 'branch' }, { deliveryId: id });
    expect(first.status).toBe('processed');
    expect(second.status).toBe('duplicate');
    expect(await linksOf(issue.id)).toHaveLength(1); // not doubled
  });

  it('unknown installation ids are ledgered but never touch any tenant', async () => {
    const rawPayload = { installation: { id: 99999999 }, repository: { full_name: REPO }, ref: `${teamKey}-1-x`, ref_type: 'branch' };
    const rawBody = Buffer.from(JSON.stringify(rawPayload));
    const res = await github.handleDelivery({
      deliveryId: `dlv-alien-${rid()}`,
      event: 'create',
      signature: 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex'),
      rawBody,
      payload: rawPayload,
    });
    expect(res.status).toBe('unmapped_installation');
  });
});

describe('GitHub E2E fixture chain (§12.3) — Todo → In Progress → In Review → Done', () => {
  let issueId: string;
  let num: number;

  beforeAll(async () => {
    const issue = (
      await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: 'Fix SSO redirect loop', assignee_user_id: ownerId })
    ).data;
    issueId = issue.id;
    num = issue.number;
    // Start from the unstarted default (Todo) so the chain walks every step.
    const [todo] = await dbAdmin
      .select()
      .from(pmWorkflowStates)
      .where(and(eq(pmWorkflowStates.team_id, teamId), eq(pmWorkflowStates.name, 'Todo')));
    await issuesSvc.moveState(tenantId, ownerId, issueId, todo!.id);
  });

  it('branch created → branch chip + auto-move to In Progress', async () => {
    const branch = `sara/${teamKey.toLowerCase()}-${num}-sso-loop`;
    const res = await deliver('create', { ref: branch, ref_type: 'branch' });
    expect(res.status).toBe('processed');
    await settle();
    const links = await linksOf(issueId);
    expect(links.some((l) => l.kind === 'branch' && l.ref === branch && l.state === 'open')).toBe(true);
    expect((await stateOf(issueId)).name).toBe('In Progress');
  });

  it('PR opened → PR chip + auto-move to In Review', async () => {
    const res = await deliver('pull_request', {
      action: 'opened',
      pull_request: {
        number: 412,
        title: 'Fix SSO redirect',
        body: 'work for this branch',
        html_url: `https://github.com/${REPO}/pull/412`,
        head: { ref: `sara/${teamKey.toLowerCase()}-${num}-sso-loop` },
      },
    });
    expect(res.status).toBe('processed');
    await settle();
    const links = await linksOf(issueId);
    expect(links.some((l) => l.kind === 'pr' && l.ref === '412' && l.state === 'open')).toBe(true);
    expect((await stateOf(issueId)).name).toBe('In Review');
  });

  it('PR merged with a magic word → Done, chip merged, history + inbox written', async () => {
    const res = await deliver('pull_request', {
      action: 'closed',
      pull_request: {
        number: 412,
        title: 'Fix SSO redirect',
        body: `Fixes ${teamKey}-${num}`,
        merged: true,
        html_url: `https://github.com/${REPO}/pull/412`,
        head: { ref: `sara/${teamKey.toLowerCase()}-${num}-sso-loop` },
      },
    });
    expect(res.status).toBe('processed');
    await settle();
    const state = await stateOf(issueId);
    expect(state.category).toBe('completed');
    const links = await linksOf(issueId);
    expect(links.find((l) => l.kind === 'pr' && l.ref === '412')!.state).toBe('merged');
    const history = await dbAdmin
      .select()
      .from(pmIssueHistory)
      .where(and(eq(pmIssueHistory.issue_id, issueId), eq(pmIssueHistory.field, 'git')));
    expect(history.some((h) => (h.to_value ?? '').includes('merged'))).toBe(true);
    // Assignee (owner) got the inbox ping, collapsed on the issue group key.
    const inbox = await dbAdmin
      .select()
      .from(notifications)
      .where(and(eq(notifications.user_id, ownerId), eq(notifications.group_key, `pm.issue:${issueId}`)));
    expect(inbox.length).toBeGreaterThan(0);
    expect(inbox.some((n) => n.type.startsWith('pm.github.'))).toBe(true);
  });

  it('installation health recorded on the way through', async () => {
    const status = await github.status(tenantId, ownerId);
    expect(status.data.installation!.last_delivery_status).toBe(200);
    expect(status.data.installation!.failed_deliveries).toBe(0);
  });
});

describe('Close-unmerged + toggles + isolation', () => {
  it('PR closed WITHOUT merge → issue returns to backlog + inbox note', async () => {
    const issue = (
      await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: 'Abandoned work', assignee_user_id: ownerId })
    ).data;
    const [inProgress] = await dbAdmin
      .select()
      .from(pmWorkflowStates)
      .where(and(eq(pmWorkflowStates.team_id, teamId), eq(pmWorkflowStates.name, 'In Progress')));
    await issuesSvc.moveState(tenantId, ownerId, issue.id, inProgress!.id);

    await deliver('pull_request', {
      action: 'closed',
      pull_request: {
        number: 500,
        title: `${teamKey}-${issue.number} abandoned approach`,
        merged: false,
        head: { ref: 'misc/dead-end' },
      },
    });
    await settle();
    const state = await stateOf(issue.id);
    expect(['backlog', 'unstarted']).toContain(state.category);
    const inbox = await dbAdmin
      .select()
      .from(notifications)
      .where(and(eq(notifications.user_id, ownerId), eq(notifications.group_key, `pm.issue:${issue.id}`)));
    expect(inbox.some((n) => n.type === 'pm.github.pr_closed')).toBe(true);
  });

  it('gh_magic_words OFF → merge does not complete the referenced issue', async () => {
    await teamsSvc.updateConfig(tenantId, ownerId, 'owner', teamId, { gh_magic_words: false, gh_auto_pr_merge: false });
    const issue = (await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: 'Protected from magic' })).data;
    await deliver('pull_request', {
      action: 'closed',
      pull_request: { number: 501, title: 'cleanup', body: `Closes ${teamKey}-${issue.number}`, merged: true, head: { ref: 'misc/cleanup' } },
    });
    await settle();
    expect((await stateOf(issue.id)).category).not.toBe('completed');
    await teamsSvc.updateConfig(tenantId, ownerId, 'owner', teamId, { gh_magic_words: true, gh_auto_pr_merge: true });
  });

  it('push commits attach commit chips by message key', async () => {
    const issue = (await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: 'Commit target' })).data;
    await deliver('push', {
      commits: [
        { id: '9f2c1d7abc123', message: `${teamKey}-${issue.number} idx tenant_seq`, url: `https://github.com/${REPO}/commit/9f2c1d7` },
      ],
    });
    const links = await linksOf(issue.id);
    expect(links.some((l) => l.kind === 'commit' && l.ref === '9f2c1d7')).toBe(true);
  });

  it('CROSS-TENANT: tenant B installation can never link tenant A issues (§16)', async () => {
    // Tenant B with its own installation + a repo mapped to a team that
    // shares tenant A's team KEY — the strongest confusion case.
    const [tb] = await dbAdmin
      .insert(tenants)
      .values({ name: `GH Beta ${rid()}`, slug: `ghb-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
      .returning();
    const [ub] = await dbAdmin
      .insert(users)
      .values({ email: `ghb-${rid()}@t.test`, full_name: 'B Owner', status: 'active' })
      .returning();
    await dbAdmin.insert(memberships).values({ tenant_id: tb!.id, user_id: ub!.id, role: 'owner', status: 'active' });
    await teamsSvc.ensureWorkspace(tb!.id, ub!.id);
    const [teamB] = await dbAdmin.select().from(pmTeams).where(eq(pmTeams.tenant_id, tb!.id));
    const B_INSTALL = INSTALLATION_ID + 1;
    await github.claimInstallation(tb!.id, ub!.id, { installation_id: B_INSTALL, account_login: 'beta-org' });
    await github.mapRepo(tb!.id, ub!.id, { repo_full_name: 'beta/repo', team_id: teamB!.id });

    // Tenant A issue that a malicious/mistaken branch name in B references.
    const issueA = (await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: 'A-only issue' })).data;
    const payload = {
      installation: { id: B_INSTALL },
      repository: { full_name: 'beta/repo' },
      ref: `${teamKey}-${issueA.number}-steal`,
      ref_type: 'branch',
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const res = await github.handleDelivery({
      deliveryId: `dlv-xt-${rid()}`,
      event: 'create',
      signature: 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex'),
      rawBody,
      payload,
    });
    expect(res.status).toBe('processed');
    await settle();
    // The A issue is untouched — no link, no state change.
    expect(await linksOf(issueA.id)).toHaveLength(0);

    await dbAdmin.delete(githubWebhookEvents).where(eq(githubWebhookEvents.installation_id, B_INSTALL));
    await dbAdmin.delete(domainEvents).where(eq(domainEvents.tenant_id, tb!.id));
    await dbAdmin.delete(tenants).where(eq(tenants.id, tb!.id));
    await dbAdmin.delete(users).where(eq(users.id, ub!.id));
  });
});
