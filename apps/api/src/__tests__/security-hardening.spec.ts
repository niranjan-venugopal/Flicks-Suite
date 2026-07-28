/**
 * Security hardening pass — regression tests for the pre-beta audit findings.
 *
 * H1 GitHub installation claim needs a server-minted state nonce
 * H2 recently-deleted honours private-team visibility
 * H3 webhook signature fails CLOSED and records the real verdict
 * M1 notification reads/writes are tenant-scoped
 * M3 PM import undo cannot touch a CRM batch
 * M4 OTP codes come from crypto, not Math.random
 * M6 label edits re-check the label's ACTUAL team
 * L5 webhook-supplied URLs are allow-listed to github.com
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  importBatches,
  memberships,
  notifications,
  pmGithubInstallations,
  pmIssueGitLinks,
  pmIssues,
  pmLabels,
  pmTeamMemberships,
  pmTeams,
  pmWorkflowStates,
  tenants,
  users,
} from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { DomainEventsService } from '../core/events/domain-events.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { PmVisibilityService } from '../modules/pm/sync/visibility.service';
import { PmTeamsService } from '../modules/pm/teams.service';
import { PmIssuesService } from '../modules/pm/issues.service';
import { PmImportService } from '../modules/pm/import.service';
import { PmGithubService } from '../modules/pm/github.service';
import { GithubAppService } from '../modules/pm/github-app.service';

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const emitter = new EventEmitter2();
const domainEventsSvc = new DomainEventsService(dbAdmin as never, emitter);
const config = new ConfigService();
const notificationsSvc = new NotificationsService(db as never, dbAdmin as never, config, emitter);
const visibility = new PmVisibilityService(dbSvc);
const teamsSvc = new PmTeamsService(dbSvc, audit, domainEventsSvc, visibility);
const issuesSvc = new PmIssuesService(dbSvc, audit, domainEventsSvc, notificationsSvc);
const importSvc = new PmImportService(dbSvc, audit, domainEventsSvc);

const redisStub = (() => {
  const store = new Map<string, string>();
  return {
    async set(k: string, v: string) { store.set(k, v); return 'OK'; },
    async get(k: string) { return store.get(k) ?? null; },
    async del(k: string) { return store.delete(k) ? 1 : 0; },
    async incr(k: string) { const n = Number(store.get(k) ?? 0) + 1; store.set(k, String(n)); return n; },
    async expire() { return 1; },
  };
})();
const github = new PmGithubService(
  dbSvc, dbAdmin as never, config, audit, domainEventsSvc,
  notificationsSvc, issuesSvc, new GithubAppService(config), redisStub as never,
);

let tenantId: string;
let otherTenantId: string;
let ownerId: string;
let outsiderId: string;
let privateTeamId: string;
let privateIssueId: string;
let privateLabelId: string;

beforeAll(async () => {
  const mkTenant = async (n: string) =>
    (await dbAdmin.insert(tenants).values({ name: n, slug: `sec-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' }).returning())[0]!;
  const mkUser = async (email: string, tid: string, role: 'owner' | 'employee') => {
    const [u] = await dbAdmin.insert(users).values({ email, full_name: 'Sec Tester', status: 'active' }).returning();
    await dbAdmin.insert(memberships).values({ tenant_id: tid, user_id: u!.id, role, status: 'active' });
    return u!.id;
  };
  tenantId = (await mkTenant(`SecA${rid()}`)).id;
  otherTenantId = (await mkTenant(`SecB${rid()}`)).id;
  ownerId = await mkUser(`owner-${rid()}@sec.test`, tenantId, 'owner');
  outsiderId = await mkUser(`outsider-${rid()}@sec.test`, tenantId, 'employee');

  // A PRIVATE team the outsider is not a member of.
  const [team] = await dbAdmin.insert(pmTeams).values({
    tenant_id: tenantId, key: `SEC${rid().slice(0, 2).toUpperCase()}`, name: 'Security', is_private: true,
  }).returning();
  privateTeamId = team!.id;
  await dbAdmin.insert(pmTeamMemberships).values({ tenant_id: tenantId, team_id: privateTeamId, user_id: ownerId });
  const [state] = await dbAdmin.insert(pmWorkflowStates).values({
    tenant_id: tenantId, team_id: privateTeamId, name: 'Todo', color: '#A8B0C2', category: 'unstarted', position: 1,
  }).returning();
  const [issue] = await dbAdmin.insert(pmIssues).values({
    tenant_id: tenantId, team_id: privateTeamId, number: 1,
    title: 'Rotate leaked production credentials', state_id: state!.id,
    board_rank: 'm', backlog_rank: 'm', deleted_at: new Date(),
  }).returning();
  privateIssueId = issue!.id;
  const [label] = await dbAdmin.insert(pmLabels).values({
    tenant_id: tenantId, team_id: privateTeamId, name: 'security-only', color: '#F8786B',
  }).returning();
  privateLabelId = label!.id;
});

afterAll(async () => {
  for (const t of [tenantId, otherTenantId]) await dbAdmin.delete(tenants).where(eq(tenants.id, t));
  for (const u of [ownerId, outsiderId]) await dbAdmin.delete(users).where(eq(users.id, u));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.().catch(() => {});
});

describe('H2 — recently deleted respects private-team visibility', () => {
  it('hides a private team issue from a non-member but shows it to a member', async () => {
    const outsider = await teamsSvc.recentlyDeleted(tenantId, outsiderId);
    expect(outsider.data.issues.find((i) => i.id === privateIssueId)).toBeUndefined();
    expect(outsider.data.issues.some((i) => i.title.includes('leaked production'))).toBe(false);

    const member = await teamsSvc.recentlyDeleted(tenantId, ownerId);
    expect(member.data.issues.find((i) => i.id === privateIssueId)).toBeDefined();
  });
});

describe('H1 — GitHub installation claim requires a minted state nonce', () => {
  const installationId = 880000 + Math.floor(Math.random() * 90000);

  it('rejects a claim with no state (installation-id squatting)', async () => {
    await expect(
      github.claimInstallation(tenantId, ownerId, { installation_id: installationId, state: '' }),
    ).rejects.toThrow(/could not be verified/i);
  });

  it('rejects a state minted for a DIFFERENT tenant', async () => {
    const { data } = await github.startInstall(otherTenantId, ownerId);
    await expect(
      github.claimInstallation(tenantId, ownerId, { installation_id: installationId, state: data.state }),
    ).rejects.toThrow(/could not be verified/i);
  });

  it('accepts a freshly minted state, and the nonce is single-use', async () => {
    const { data } = await github.startInstall(tenantId, ownerId);
    const res = await github.claimInstallation(tenantId, ownerId, {
      installation_id: installationId, account_login: 'sec-org', state: data.state,
    });
    expect(res.data.installation_id).toBe(installationId);
    // replay of the same nonce must fail
    await expect(
      github.claimInstallation(tenantId, ownerId, { installation_id: installationId + 1, state: data.state }),
    ).rejects.toThrow(/could not be verified/i);
    await dbAdmin.delete(pmGithubInstallations).where(eq(pmGithubInstallations.tenant_id, tenantId));
  });
});

describe('H3 — webhook signature fails closed', () => {
  it('throws when no secret is configured and the local opt-in is absent', () => {
    expect(() => github.signatureVerdict(Buffer.from('{}'), 'sha256=deadbeef')).toThrow(
      /secret not configured/i,
    );
  });

  it('accepts a correct HMAC and reports verified=true', () => {
    const secret = 'test-webhook-secret';
    const scoped = new PmGithubService(
      dbSvc, dbAdmin as never,
      { get: (k: string) => (k === 'GITHUB_WEBHOOK_SECRET' ? secret : undefined) } as never,
      audit, domainEventsSvc, notificationsSvc, issuesSvc, new GithubAppService(config), redisStub as never,
    );
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    expect(scoped.signatureVerdict(body, sig)).toEqual({ accept: true, verified: true });
    expect(scoped.signatureVerdict(body, 'sha256=' + '0'.repeat(64))).toEqual({ accept: false, verified: false });
  });
});

describe('M1 — notifications are tenant-scoped', () => {
  it('a user with memberships in two tenants only sees the active tenant feed', async () => {
    await dbAdmin.insert(memberships).values({ tenant_id: otherTenantId, user_id: ownerId, role: 'owner', status: 'active' });
    await dbAdmin.insert(notifications).values([
      { tenant_id: tenantId, user_id: ownerId, type: 'pm.issue.mention', message: 'SEC-1 mentioned you — tenant A secret' },
      { tenant_id: otherTenantId, user_id: ownerId, type: 'pm.issue.mention', message: 'OTH-9 mentioned you — tenant B secret' },
    ]);

    const inboxA = await notificationsSvc.getInbox(ownerId, { scope: 'all', tenantId });
    expect(inboxA.items.some((i) => i.message.includes('tenant A secret'))).toBe(true);
    expect(inboxA.items.some((i) => i.message.includes('tenant B secret'))).toBe(false);

    const unreadA = await notificationsSvc.getUnread(ownerId, 20, tenantId);
    expect(unreadA.items.some((i) => i.message.includes('tenant B secret'))).toBe(false);

    // ...and archiving from tenant A cannot touch the tenant B row.
    const [rowB] = await dbAdmin
      .select()
      .from(notifications)
      .where(and(eq(notifications.user_id, ownerId), eq(notifications.tenant_id, otherTenantId)));
    await notificationsSvc.archive(rowB!.id, ownerId, tenantId);
    const [stillOpen] = await dbAdmin.select().from(notifications).where(eq(notifications.id, rowB!.id));
    expect(stillOpen!.archived_at).toBeNull();
  });
});

describe('M3 — PM import undo cannot strand a CRM batch', () => {
  it('refuses a batch whose object_type belongs to CRM', async () => {
    const [crmBatch] = await dbAdmin
      .insert(importBatches)
      .values({ tenant_id: tenantId, object_type: 'leads', status: 'done', created_by: ownerId })
      .returning();
    await expect(importSvc.undo(tenantId, ownerId, crmBatch!.id)).rejects.toThrow(/not found/i);
    const [after] = await dbAdmin.select().from(importBatches).where(eq(importBatches.id, crmBatch!.id));
    expect(after!.status).toBe('done'); // untouched — CRM undo still works
  });
});

describe('M6 — label edits re-check the label’s real team', () => {
  it('a non-member cannot rename a private team’s label by passing their own team_id', async () => {
    const [ownTeam] = await dbAdmin.insert(pmTeams).values({
      tenant_id: tenantId, key: `OWN${rid().slice(0, 2).toUpperCase()}`, name: 'Outsider team', is_private: false,
    }).returning();
    await dbAdmin.insert(pmTeamMemberships).values({
      tenant_id: tenantId, team_id: ownTeam!.id, user_id: outsiderId, is_lead: true,
    });
    await expect(
      teamsSvc.upsertLabel(tenantId, outsiderId, 'employee', {
        id: privateLabelId, team_id: ownTeam!.id, name: 'pwned', color: '#000000',
      }),
    ).rejects.toThrow();
    const [label] = await dbAdmin.select().from(pmLabels).where(eq(pmLabels.id, privateLabelId));
    expect(label!.name).toBe('security-only');
  });
});

describe('L1 — teams.list does not leak private-team labels', () => {
  it('omits a private team label from a non-member payload', async () => {
    const res = await teamsSvc.list(tenantId, outsiderId);
    expect(res.data.labels.find((l) => l.id === privateLabelId)).toBeUndefined();
  });
});

describe('L5 — git link URLs are allow-listed', () => {
  it('drops a javascript: url and keeps a real github url', async () => {
    const [state] = await dbAdmin
      .select()
      .from(pmWorkflowStates)
      .where(eq(pmWorkflowStates.team_id, privateTeamId));
    const [issue] = await dbAdmin.insert(pmIssues).values({
      tenant_id: tenantId, team_id: privateTeamId, number: 2, title: 'Link target',
      state_id: state!.id, board_rank: 'n', backlog_rank: 'n',
    }).returning();
    const svc = github as unknown as {
      attachLink: (t: string, i: { id: string }, l: Record<string, unknown>) => Promise<void>;
    };
    await svc.attachLink(tenantId, { id: issue!.id } as never, {
      kind: 'pr', ref: '1', label: 'evil', url: 'javascript:alert(document.cookie)',
    });
    await svc.attachLink(tenantId, { id: issue!.id } as never, {
      kind: 'pr', ref: '2', label: 'real', url: 'https://github.com/acme/repo/pull/2',
    });
    const links = await dbAdmin.select().from(pmIssueGitLinks).where(eq(pmIssueGitLinks.issue_id, issue!.id));
    expect(links.find((l) => l.ref === '1')!.url).toBeNull();
    expect(links.find((l) => l.ref === '2')!.url).toBe('https://github.com/acme/repo/pull/2');
  });
});

describe('M4 — OTP codes are cryptographically random', () => {
  it('auth.service uses crypto.randomInt, never Math.random', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../modules/auth/auth.service.ts'),
      'utf8',
    ) as string;
    const otpLine = src.split('\n').find((l) => l.includes('const otpCode'));
    expect(otpLine).toContain('crypto.randomInt');
    expect(src).not.toMatch(/Math\.random\(\)\s*\*\s*900000/);
  });
});
