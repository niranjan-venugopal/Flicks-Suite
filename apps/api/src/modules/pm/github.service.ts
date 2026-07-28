import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Inject } from '@nestjs/common';
import type Redis from 'ioredis';
import * as crypto from 'crypto';
import { REDIS_CLIENT } from '../../core/redis/redis.module';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  pmGithubInstallations,
  pmGithubRepos,
  pmIssueGitLinks,
  githubWebhookEvents,
  pmIssues,
  pmTeams,
  pmWorkflowStates,
  pmIssueSubscribers,
  pmIssueHistory,
} from '@flicks/db/schema';
import type { Db, DbAdmin } from '@flicks/db';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventsService } from '../../core/events/domain-events.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PmIssuesService } from './issues.service';
import { GithubAppService } from './github-app.service';

/**
 * GitHub integration (PRD v6 §12): install claim + repo↔team mapping + the
 * webhook pipeline — X-Hub-Signature-256 verify, delivery-id idempotency,
 * TEAM-123 autolinks from branches/PRs/commits, per-team status automations,
 * magic words on merge. Inbound deliveries carry no user context, so ledger
 * writes ride the service role; issue writes run under the tenant with the
 * connecting admin as actor (falling back to the issue creator).
 */

const KEY_RE = /([A-Za-z][A-Za-z0-9]{0,5})-(\d{1,6})/g;
const MAGIC_RE = /\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s*:?\s+([A-Za-z][A-Za-z0-9]{0,5}-\d{1,6})/gi;

export interface DeliveryInput {
  deliveryId: string;
  event: string;
  signature: string | undefined; // X-Hub-Signature-256 header
  rawBody: Buffer;
  payload: Record<string, unknown>;
}

interface ResolvedIssue {
  id: string;
  team_id: string;
  number: number;
  title: string;
  state_id: string;
  assignee_user_id: string | null;
  created_by: string | null;
  teamKey: string;
}

/**
 * Webhook payloads are attacker-shaped data; these URLs are rendered as
 * anchor hrefs on the issue page. Only absolute https://github.com links
 * survive — a `javascript:` value would otherwise be stored XSS on click.
 */
function safeGithubUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const ok = u.protocol === 'https:' && (host === 'github.com' || host.endsWith('.github.com'));
    return ok ? u.toString() : null;
  } catch {
    return null;
  }
}

function parseKeys(...texts: Array<string | null | undefined>): Array<{ key: string; number: number }> {
  const seen = new Set<string>();
  const out: Array<{ key: string; number: number }> = [];
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(KEY_RE)) {
      const key = m[1]!.toUpperCase();
      const number = Number(m[2]);
      const dedupe = `${key}-${number}`;
      if (!seen.has(dedupe)) {
        seen.add(dedupe);
        out.push({ key, number });
      }
    }
  }
  return out;
}

function parseMagicKeys(...texts: Array<string | null | undefined>): Array<{ key: string; number: number }> {
  const seen = new Set<string>();
  const out: Array<{ key: string; number: number }> = [];
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(MAGIC_RE)) {
      const [key, num] = m[1]!.toUpperCase().split('-');
      const dedupe = `${key}-${num}`;
      if (!seen.has(dedupe)) {
        seen.add(dedupe);
        out.push({ key: key!, number: Number(num) });
      }
    }
  }
  return out;
}

@Injectable()
export class PmGithubService {
  private readonly logger = new Logger(PmGithubService.name);

  constructor(
    private readonly db: DatabaseService,
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly domainEvents: DomainEventsService,
    private readonly notifications: NotificationsService,
    private readonly issues: PmIssuesService,
    private readonly app: GithubAppService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  // ─── Install handshake (§12.1) ─────────────────────────────────────────────
  // An installation_id alone proves nothing: it is a small sequential integer
  // and the App JWT can read ANY installation of the App. So the claim must
  // carry a state nonce this server minted for THIS tenant and handed to
  // GitHub as ?state= on the install redirect. Without it, a tenant could
  // squat another org's installation id and receive their webhook traffic.

  private stateKey(state: string): string {
    return `pm:gh:install-state:${state}`;
  }

  /** Mint the install URL + one-shot state nonce (10 min TTL). */
  async startInstall(tenantId: string, userId: string) {
    const slug = this.appSlug();
    const state = crypto.randomBytes(24).toString('hex');
    await this.redis.set(
      this.stateKey(state),
      JSON.stringify({ tenantId, userId }),
      'EX',
      600,
    );
    return {
      data: {
        state,
        url: slug ? `https://github.com/apps/${slug}/installations/new?state=${state}` : null,
      },
    };
  }

  /** Consume the nonce; true only when it was minted for this tenant. */
  private async consumeInstallState(state: string | undefined, tenantId: string): Promise<boolean> {
    if (!state) return false;
    const key = this.stateKey(state);
    const raw = await this.redis.get(key);
    if (!raw) return false;
    await this.redis.del(key); // one-shot
    try {
      return (JSON.parse(raw) as { tenantId?: string }).tenantId === tenantId;
    } catch {
      return false;
    }
  }

  // ─── Settings (P16) ────────────────────────────────────────────────────────

  async status(tenantId: string, userId: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [installation] = await tx
          .select()
          .from(pmGithubInstallations)
          .where(eq(pmGithubInstallations.tenant_id, tenantId))
          .limit(1);
        if (!installation) return { data: { installation: null, repos: [], app_slug: this.appSlug() } };
        const repos = await tx
          .select({
            id: pmGithubRepos.id,
            repo_full_name: pmGithubRepos.repo_full_name,
            team_id: pmGithubRepos.team_id,
            team_key: pmTeams.key,
            autolink: pmGithubRepos.autolink,
          })
          .from(pmGithubRepos)
          .innerJoin(pmTeams, eq(pmTeams.id, pmGithubRepos.team_id))
          .where(eq(pmGithubRepos.tenant_id, tenantId))
          .orderBy(asc(pmGithubRepos.repo_full_name));
        return { data: { installation, repos, app_slug: this.appSlug() } };
      },
      userId,
    );
  }

  private appSlug(): string | null {
    return this.config.get<string>('GITHUB_APP_SLUG') || null;
  }

  /**
   * Claim an installation for this tenant (the App's post-install setup
   * redirect carries ?installation_id=…). Verified against the GitHub API
   * when App credentials are configured; accepted as-declared otherwise
   * (local/dev + fixture testing).
   */
  async claimInstallation(
    tenantId: string,
    userId: string,
    input: { installation_id: number; account_login?: string; state?: string },
  ) {
    if (!Number.isInteger(input.installation_id) || input.installation_id <= 0) {
      throw new BadRequestException('installation_id must be a positive integer');
    }
    // Ownership proof: the state nonce we minted for this tenant and GitHub
    // echoed back on the setup redirect. getInstallation() below only proves
    // the id EXISTS (App JWT sees every installation) — never that this
    // tenant installed it, so the nonce is the load-bearing check.
    const proven = await this.consumeInstallState(input.state, tenantId);
    if (!proven) {
      throw new BadRequestException(
        'Installation could not be verified — start the install from Projects → Settings → GitHub so the request carries a valid state.',
      );
    }
    let login = input.account_login?.trim() || 'unknown';
    if (this.app.configured) {
      const remote = await this.app.getInstallation(input.installation_id);
      if (!remote) throw new BadRequestException('Installation not found for this GitHub App');
      login = remote.account_login;
    }
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [row] = await tx
          .insert(pmGithubInstallations)
          .values({
            tenant_id: tenantId,
            installation_id: input.installation_id,
            account_login: login,
            created_by: userId,
          })
          .onConflictDoUpdate({
            target: pmGithubInstallations.tenant_id,
            set: {
              installation_id: input.installation_id,
              account_login: login,
              status: 'active',
              failed_deliveries: 0,
              updated_at: new Date(),
            },
          })
          .returning();
        await this.audit.log({
          tenantId,
          actorUserId: userId,
          action: 'pm.github.install',
          resourceType: 'pm_github_installation',
          resourceId: row!.id,
          metadata: { installation_id: input.installation_id, account_login: login },
        });
        await this.domainEvents.publish(
          {
            name: 'pm.github.installed',
            tenantId,
            actorUserId: userId,
            payload: { installation_id: input.installation_id },
          },
          tx,
        );
        return { data: row! };
      },
      userId,
    );
  }

  async uninstall(tenantId: string, userId: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [row] = await tx
          .delete(pmGithubInstallations)
          .where(eq(pmGithubInstallations.tenant_id, tenantId))
          .returning();
        if (!row) throw new NotFoundException('No GitHub installation to remove');
        await tx.delete(pmGithubRepos).where(eq(pmGithubRepos.tenant_id, tenantId));
        await this.audit.log({
          tenantId,
          actorUserId: userId,
          action: 'pm.github.uninstall',
          resourceType: 'pm_github_installation',
          resourceId: row.id,
          metadata: { installation_id: row.installation_id },
        });
        return { data: { removed: true } };
      },
      userId,
    );
  }

  async mapRepo(
    tenantId: string,
    userId: string,
    input: { repo_full_name: string; team_id: string; repo_id?: number },
  ) {
    const name = input.repo_full_name?.trim();
    if (!name || !/^[\w.-]+\/[\w.-]+$/.test(name)) {
      throw new BadRequestException('repo_full_name must look like owner/repo');
    }
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [installation] = await tx
          .select()
          .from(pmGithubInstallations)
          .where(eq(pmGithubInstallations.tenant_id, tenantId))
          .limit(1);
        if (!installation) throw new BadRequestException('Connect GitHub before mapping repos');
        const [team] = await tx
          .select({ id: pmTeams.id, key: pmTeams.key })
          .from(pmTeams)
          .where(and(eq(pmTeams.id, input.team_id), eq(pmTeams.tenant_id, tenantId), isNull(pmTeams.deleted_at)))
          .limit(1);
        if (!team) throw new BadRequestException('team_id does not belong to this workspace');
        const [row] = await tx
          .insert(pmGithubRepos)
          .values({
            tenant_id: tenantId,
            installation_id: installation.installation_id,
            repo_full_name: name,
            repo_id: input.repo_id ?? null,
            team_id: team.id,
          })
          .onConflictDoUpdate({
            target: [pmGithubRepos.tenant_id, pmGithubRepos.repo_full_name],
            set: { team_id: team.id, autolink: true },
          })
          .returning();
        await this.domainEvents.publish(
          {
            name: 'pm.github.repo_mapped',
            tenantId,
            actorUserId: userId,
            payload: { repo_full_name: name, team_id: team.id },
          },
          tx,
        );
        return { data: row! };
      },
      userId,
    );
  }

  async unmapRepo(tenantId: string, userId: string, repoRowId: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [row] = await tx
          .delete(pmGithubRepos)
          .where(and(eq(pmGithubRepos.id, repoRowId), eq(pmGithubRepos.tenant_id, tenantId)))
          .returning();
        if (!row) throw new NotFoundException('Repo mapping not found');
        return { data: { removed: true } };
      },
      userId,
    );
  }

  async setBranchFormat(tenantId: string, userId: string, format: string) {
    const clean = format?.trim();
    if (!clean || clean.length > 120) throw new BadRequestException('Invalid branch format');
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [row] = await tx
          .update(pmGithubInstallations)
          .set({ branch_format: clean, updated_at: new Date() })
          .where(eq(pmGithubInstallations.tenant_id, tenantId))
          .returning();
        if (!row) throw new NotFoundException('Connect GitHub first');
        return { data: row };
      },
      userId,
    );
  }

  /** Re-process stored verified-but-unprocessed deliveries (P16 Redeliver). */
  async redeliver(tenantId: string, userId: string) {
    const [installation] = await this.dbAdmin
      .select()
      .from(pmGithubInstallations)
      .where(eq(pmGithubInstallations.tenant_id, tenantId))
      .limit(1);
    if (!installation) throw new NotFoundException('No GitHub installation');
    const pending = await this.dbAdmin
      .select()
      .from(githubWebhookEvents)
      .where(
        and(
          eq(githubWebhookEvents.installation_id, installation.installation_id),
          eq(githubWebhookEvents.signature_verified, true),
          eq(githubWebhookEvents.processed, false),
        ),
      )
      .orderBy(asc(githubWebhookEvents.received_at))
      .limit(50);
    let ok = 0;
    for (const row of pending) {
      const done = await this.processLedgerRow(row.id, tenantId, row.event, (row.payload ?? {}) as Record<string, unknown>);
      if (done) ok++;
    }
    if (ok > 0) {
      await this.dbAdmin
        .update(pmGithubInstallations)
        .set({ status: 'active', failed_deliveries: 0, updated_at: new Date() })
        .where(eq(pmGithubInstallations.id, installation.id));
    }
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'pm.github.redeliver',
      resourceType: 'pm_github_installation',
      resourceId: installation.id,
      metadata: { reprocessed: ok, pending: pending.length },
    });
    return { data: { reprocessed: ok, pending: pending.length } };
  }

  /** Git links for an issue (detail bundle + chips). */
  async linksForIssue(tx: Db, tenantId: string, issueId: string) {
    return tx
      .select()
      .from(pmIssueGitLinks)
      .where(and(eq(pmIssueGitLinks.tenant_id, tenantId), eq(pmIssueGitLinks.issue_id, issueId)))
      .orderBy(asc(pmIssueGitLinks.created_at));
  }

  // ─── Webhook pipeline ──────────────────────────────────────────────────────

  /**
   * X-Hub-Signature-256 verify — HMAC-SHA256 hex, timing-safe (§12.2).
   * FAIL CLOSED: a missing secret rejects the delivery in every environment.
   * Local fixture runs opt in explicitly with ALLOW_UNSIGNED_GITHUB_WEBHOOKS=1,
   * which is refused outright when NODE_ENV=production — an unset/odd NODE_ENV
   * (staging, empty) must never silently open a public unauthenticated write.
   */
  verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
    return this.signatureVerdict(rawBody, signatureHeader).verified;
  }

  /**
   * `accept` = process this delivery; `verified` = the HMAC actually matched
   * (what the ledger records, so an unsigned local delivery can never be
   * replayed later as if GitHub had signed it).
   */
  signatureVerdict(
    rawBody: Buffer,
    signatureHeader: string | undefined,
  ): { accept: boolean; verified: boolean } {
    const secret = this.config.get<string>('GITHUB_WEBHOOK_SECRET');
    if (!secret) {
      const optedIn =
        this.config.get<string>('ALLOW_UNSIGNED_GITHUB_WEBHOOKS') === '1' &&
        process.env.NODE_ENV !== 'production';
      if (!optedIn) {
        throw new UnauthorizedException('GitHub webhook secret not configured');
      }
      this.logger.warn('ALLOW_UNSIGNED_GITHUB_WEBHOOKS=1 — accepting an UNVERIFIED delivery (local only)');
      return { accept: true, verified: false };
    }
    if (!signatureHeader?.startsWith('sha256=')) return { accept: false, verified: false };
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const given = signatureHeader.slice('sha256='.length);
    if (given.length !== expected.length) return { accept: false, verified: false };
    const ok = crypto.timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(expected, 'utf8'));
    return { accept: ok, verified: ok };
  }

  /**
   * Entry point for POST /webhooks/github. Verifies, ledgers (delivery-id
   * idempotent), resolves the tenant from installation_id, processes inline,
   * records health. Always safe to call twice with the same delivery id.
   */
  async handleDelivery(input: DeliveryInput): Promise<{ status: string }> {
    const verdict = this.signatureVerdict(input.rawBody, input.signature);
    if (!verdict.accept) {
      throw new UnauthorizedException('Invalid X-Hub-Signature-256');
    }
    const installationId = Number(
      (input.payload.installation as { id?: number } | undefined)?.id ?? NaN,
    );
    const [installation] = Number.isInteger(installationId)
      ? await this.dbAdmin
          .select()
          .from(pmGithubInstallations)
          .where(eq(pmGithubInstallations.installation_id, installationId))
          .limit(1)
      : [];

    // Ledger claim — the UNIQUE(delivery_id) makes redelivery a no-op.
    const [claimed] = await this.dbAdmin
      .insert(githubWebhookEvents)
      .values({
        delivery_id: input.deliveryId,
        event: input.event,
        action: (input.payload.action as string) ?? null,
        installation_id: Number.isInteger(installationId) ? installationId : null,
        tenant_id: installation?.tenant_id ?? null,
        signature_verified: verdict.verified,
        payload: input.payload,
      })
      .onConflictDoNothing({ target: githubWebhookEvents.delivery_id })
      .returning({ id: githubWebhookEvents.id });
    if (!claimed) return { status: 'duplicate' };
    if (!installation) return { status: 'unmapped_installation' };

    const ok = await this.processLedgerRow(claimed.id, installation.tenant_id, input.event, input.payload);
    await this.dbAdmin
      .update(pmGithubInstallations)
      .set({
        last_delivery_at: new Date(),
        last_delivery_status: ok ? 200 : 500,
        ...(ok
          ? { status: 'active', failed_deliveries: 0 }
          : { status: 'error', failed_deliveries: sql`${pmGithubInstallations.failed_deliveries} + 1` }),
        updated_at: new Date(),
      })
      .where(eq(pmGithubInstallations.id, installation.id));
    return { status: ok ? 'processed' : 'error' };
  }

  private async processLedgerRow(
    ledgerId: string,
    tenantId: string,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      await this.processEvent(tenantId, event, payload);
      await this.dbAdmin
        .update(githubWebhookEvents)
        .set({ processed: true, processed_at: new Date(), processing_error: null })
        .where(eq(githubWebhookEvents.id, ledgerId));
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`github delivery ${ledgerId} failed: ${msg}`);
      await this.dbAdmin
        .update(githubWebhookEvents)
        .set({ processing_error: msg.slice(0, 500) })
        .where(eq(githubWebhookEvents.id, ledgerId));
      return false;
    }
  }

  // ─── Event processing (§12.3) ──────────────────────────────────────────────

  private async processEvent(tenantId: string, event: string, payload: Record<string, unknown>) {
    const repoName = (payload.repository as { full_name?: string } | undefined)?.full_name;
    if (!repoName) return; // installation lifecycle events etc. — nothing to link
    const [mapping] = await this.dbAdmin
      .select()
      .from(pmGithubRepos)
      .where(and(eq(pmGithubRepos.tenant_id, tenantId), eq(pmGithubRepos.repo_full_name, repoName)))
      .limit(1);
    if (!mapping || !mapping.autolink) return; // unmapped repo — deliberate silence

    if (event === 'create' && payload.ref_type === 'branch') {
      await this.onBranchCreated(tenantId, repoName, String(payload.ref ?? ''));
    } else if (event === 'pull_request') {
      const action = payload.action as string;
      const pr = payload.pull_request as {
        number: number;
        title?: string;
        body?: string;
        merged?: boolean;
        html_url?: string;
        head?: { ref?: string };
      };
      if (!pr) return;
      if (action === 'opened' || action === 'reopened' || action === 'ready_for_review') {
        await this.onPrOpened(tenantId, repoName, mapping.installation_id, pr);
      } else if (action === 'closed') {
        await this.onPrClosed(tenantId, repoName, pr);
      }
    } else if (event === 'push') {
      const commits = (payload.commits as Array<{ id: string; message: string; url?: string }>) ?? [];
      await this.onPush(tenantId, repoName, commits);
    }
  }

  private async resolveIssues(
    tenantId: string,
    keys: Array<{ key: string; number: number }>,
  ): Promise<ResolvedIssue[]> {
    if (!keys.length) return [];
    const teamKeys = [...new Set(keys.map((k) => k.key))];
    const teams = await this.dbAdmin
      .select({ id: pmTeams.id, key: pmTeams.key })
      .from(pmTeams)
      .where(and(eq(pmTeams.tenant_id, tenantId), inArray(pmTeams.key, teamKeys), isNull(pmTeams.deleted_at)));
    const byKey = new Map(teams.map((t) => [t.key, t.id]));
    const out: ResolvedIssue[] = [];
    for (const k of keys) {
      const teamId = byKey.get(k.key);
      if (!teamId) continue;
      const [issue] = await this.dbAdmin
        .select({
          id: pmIssues.id,
          team_id: pmIssues.team_id,
          number: pmIssues.number,
          title: pmIssues.title,
          state_id: pmIssues.state_id,
          assignee_user_id: pmIssues.assignee_user_id,
          created_by: pmIssues.creator_user_id,
        })
        .from(pmIssues)
        .where(
          and(
            eq(pmIssues.tenant_id, tenantId),
            eq(pmIssues.team_id, teamId),
            eq(pmIssues.number, k.number),
            isNull(pmIssues.deleted_at),
          ),
        )
        .limit(1);
      if (issue) out.push({ ...issue, teamKey: k.key });
    }
    return out;
  }

  /** Upsert one chip; bumps the issue row so FSE deltas refresh lists. */
  private async attachLink(
    tenantId: string,
    issue: ResolvedIssue,
    link: { kind: 'branch' | 'pr' | 'commit'; ref: string; label: string; state?: string; url?: string; repo?: string },
  ) {
    await this.dbAdmin
      .insert(pmIssueGitLinks)
      .values({
        tenant_id: tenantId,
        issue_id: issue.id,
        kind: link.kind,
        ref: link.ref,
        label: link.label,
        state: link.state ?? 'open',
        url: safeGithubUrl(link.url),
        repo_full_name: link.repo ?? null,
      })
      .onConflictDoUpdate({
        target: [pmIssueGitLinks.tenant_id, pmIssueGitLinks.issue_id, pmIssueGitLinks.kind, pmIssueGitLinks.ref],
        set: { state: link.state ?? 'open', label: link.label, updated_at: new Date() },
      });
    await this.dbAdmin
      .update(pmIssues)
      .set({ updated_at: new Date() })
      .where(and(eq(pmIssues.id, issue.id), eq(pmIssues.tenant_id, tenantId)));
    await this.domainEvents.publish({
      name: 'pm.github.link_attached',
      tenantId,
      payload: { issue_id: issue.id, kind: link.kind, ref: link.ref, sync: [{ t: 'pm_issues', id: issue.id }] },
    });
  }

  /** History line for the activity feed ("GitHub attached PR #412 …"). */
  private async writeGitHistory(tenantId: string, issue: ResolvedIssue, line: string) {
    await this.dbAdmin.insert(pmIssueHistory).values({
      tenant_id: tenantId,
      issue_id: issue.id,
      field: 'git',
      from_value: null,
      to_value: line,
      actor_user_id: await this.actorFor(tenantId, issue),
    });
  }

  /** Automations act as the connecting admin (fallback: issue creator/assignee). */
  private async actorFor(tenantId: string, issue: ResolvedIssue): Promise<string | null> {
    const [installation] = await this.dbAdmin
      .select({ created_by: pmGithubInstallations.created_by })
      .from(pmGithubInstallations)
      .where(eq(pmGithubInstallations.tenant_id, tenantId))
      .limit(1);
    return installation?.created_by ?? issue.created_by ?? issue.assignee_user_id ?? null;
  }

  private async teamConfig(tenantId: string, teamId: string) {
    const [team] = await this.dbAdmin
      .select()
      .from(pmTeams)
      .where(and(eq(pmTeams.id, teamId), eq(pmTeams.tenant_id, tenantId)))
      .limit(1);
    return team ?? null;
  }

  private async stateOf(issue: ResolvedIssue) {
    const [state] = await this.dbAdmin
      .select({ id: pmWorkflowStates.id, category: pmWorkflowStates.category, name: pmWorkflowStates.name })
      .from(pmWorkflowStates)
      .where(eq(pmWorkflowStates.id, issue.state_id))
      .limit(1);
    return state ?? null;
  }

  /** Team state by predicate, lowest position wins. */
  private async findState(
    tenantId: string,
    teamId: string,
    pick: (s: { id: string; name: string; category: string }) => boolean,
  ) {
    const states = await this.dbAdmin
      .select({ id: pmWorkflowStates.id, name: pmWorkflowStates.name, category: pmWorkflowStates.category })
      .from(pmWorkflowStates)
      .where(and(eq(pmWorkflowStates.tenant_id, tenantId), eq(pmWorkflowStates.team_id, teamId)))
      .orderBy(asc(pmWorkflowStates.position));
    return states.find(pick) ?? null;
  }

  /** moveState via the ONE service layer (history/events/notify for free). */
  private async autoMove(tenantId: string, issue: ResolvedIssue, stateId: string, why: string) {
    try {
      const actor = await this.actorFor(tenantId, issue);
      if (!actor) return false; // no attributable actor — link only, never move
      await this.issues.moveState(tenantId, actor, issue.id, stateId);
      await this.domainEvents.publish({
        name: 'pm.github.automation_fired',
        tenantId,
        payload: { issue_id: issue.id, state_id: stateId, why, sync: [{ t: 'pm_issues', id: issue.id }] },
      });
      return true;
    } catch (err) {
      this.logger.warn(`automation (${why}) on ${issue.teamKey}-${issue.number} skipped: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  /** Inbox ping to assignee + subscribers (never the nobody-case). */
  private async notifyGit(tenantId: string, issue: ResolvedIssue, type: string, line: string) {
    const subs = await this.dbAdmin
      .select({ user_id: pmIssueSubscribers.user_id })
      .from(pmIssueSubscribers)
      .where(eq(pmIssueSubscribers.issue_id, issue.id));
    const audience = [...new Set([issue.assignee_user_id, ...subs.map((s) => s.user_id)])].filter(
      (u): u is string => !!u,
    );
    for (const uid of audience) {
      void this.notifications
        .createInAppNotification(uid, type, `${issue.teamKey}-${issue.number} ${line}`, `/pm/issues/${issue.id}`, tenantId, {
          groupKey: `pm.issue:${issue.id}`,
        })
        .catch(() => undefined);
    }
  }

  private async onBranchCreated(tenantId: string, repo: string, branchRef: string) {
    const issues = await this.resolveIssues(tenantId, parseKeys(branchRef));
    for (const issue of issues) {
      await this.attachLink(tenantId, issue, {
        kind: 'branch',
        ref: branchRef,
        label: branchRef,
        state: 'open',
        repo,
        url: `https://github.com/${repo}/tree/${branchRef}`,
      });
      await this.writeGitHistory(tenantId, issue, `branch ${branchRef} created`);
      const team = await this.teamConfig(tenantId, issue.team_id);
      const current = await this.stateOf(issue);
      if (team?.gh_auto_branch && current && ['triage', 'backlog', 'unstarted'].includes(current.category)) {
        const started = await this.findState(tenantId, issue.team_id, (s) => s.category === 'started');
        if (started) await this.autoMove(tenantId, issue, started.id, 'branch_created');
      }
    }
  }

  private async onPrOpened(
    tenantId: string,
    repo: string,
    installationId: number,
    pr: { number: number; title?: string; body?: string; html_url?: string; head?: { ref?: string } },
  ) {
    const issues = await this.resolveIssues(tenantId, parseKeys(pr.head?.ref, pr.title, pr.body));
    for (const issue of issues) {
      await this.attachLink(tenantId, issue, {
        kind: 'pr',
        ref: String(pr.number),
        label: `#${pr.number} ${pr.title ?? ''}`.trim(),
        state: 'open',
        repo,
        url: pr.html_url,
      });
      await this.writeGitHistory(tenantId, issue, `PR #${pr.number} opened`);
      const team = await this.teamConfig(tenantId, issue.team_id);
      const current = await this.stateOf(issue);
      if (team?.gh_auto_pr_open && current && current.category !== 'completed' && current.category !== 'canceled') {
        // Prefer an explicit review state; otherwise stay put (prototype:
        // "PR opened started→started" — never regress the issue).
        const review = await this.findState(
          tenantId,
          issue.team_id,
          (s) => s.category === 'started' && /review/i.test(s.name),
        );
        if (review && review.id !== issue.state_id) {
          await this.autoMove(tenantId, issue, review.id, 'pr_opened');
        } else if (['triage', 'backlog', 'unstarted'].includes(current.category)) {
          const started = await this.findState(tenantId, issue.team_id, (s) => s.category === 'started');
          if (started) await this.autoMove(tenantId, issue, started.id, 'pr_opened');
        }
      }
      await this.notifyGit(tenantId, issue, 'pm.github.pr_opened', `PR #${pr.number} opened`);
      if (team?.gh_bot_comment) {
        void this.app
          .commentOnPr(installationId, repo, pr.number, `Linked to **${issue.teamKey}-${issue.number}** — ${issue.title}`)
          .catch(() => undefined);
      }
    }
  }

  private async onPrClosed(
    tenantId: string,
    repo: string,
    pr: { number: number; title?: string; body?: string; merged?: boolean; html_url?: string; head?: { ref?: string } },
  ) {
    const merged = !!pr.merged;
    const linked = await this.resolveIssues(tenantId, parseKeys(pr.head?.ref, pr.title, pr.body));
    for (const issue of linked) {
      await this.attachLink(tenantId, issue, {
        kind: 'pr',
        ref: String(pr.number),
        label: `#${pr.number} ${pr.title ?? ''}`.trim(),
        state: merged ? 'merged' : 'closed',
        repo,
        url: pr.html_url,
      });
      const team = await this.teamConfig(tenantId, issue.team_id);
      const current = await this.stateOf(issue);
      if (merged) {
        await this.writeGitHistory(tenantId, issue, `PR #${pr.number} merged`);
        if (team?.gh_auto_pr_merge && current && current.category !== 'completed' && current.category !== 'canceled') {
          const done = await this.findState(tenantId, issue.team_id, (s) => s.category === 'completed');
          if (done) await this.autoMove(tenantId, issue, done.id, 'pr_merged');
        }
        await this.notifyGit(tenantId, issue, 'pm.github.pr_merged', `PR #${pr.number} merged → Done`);
      } else {
        await this.writeGitHistory(tenantId, issue, `PR #${pr.number} closed without merge`);
        if (team?.gh_auto_pr_close && current && current.category === 'started') {
          const backlog = await this.findState(
            tenantId,
            issue.team_id,
            (s) => s.category === 'backlog' || s.category === 'unstarted',
          );
          if (backlog) await this.autoMove(tenantId, issue, backlog.id, 'pr_closed_unmerged');
        }
        await this.notifyGit(tenantId, issue, 'pm.github.pr_closed', `PR #${pr.number} closed without merge — returned to backlog`);
      }
    }
    // Magic words complete their targets on merge even without a key in the
    // branch name (§12.3 — "fixes ENG-142" in title/body).
    if (merged) {
      const magicTargets = await this.resolveIssues(tenantId, parseMagicKeys(pr.title, pr.body));
      const already = new Set(linked.map((i) => i.id));
      for (const issue of magicTargets) {
        const team = await this.teamConfig(tenantId, issue.team_id);
        if (!team?.gh_magic_words) continue;
        const current = await this.stateOf(issue);
        if (current && current.category !== 'completed' && current.category !== 'canceled') {
          const done = await this.findState(tenantId, issue.team_id, (s) => s.category === 'completed');
          if (done) await this.autoMove(tenantId, issue, done.id, 'magic_word');
        }
        if (!already.has(issue.id)) {
          await this.attachLink(tenantId, issue, {
            kind: 'pr',
            ref: String(pr.number),
            label: `#${pr.number} ${pr.title ?? ''}`.trim(),
            state: 'merged',
            repo,
            url: pr.html_url,
          });
          await this.writeGitHistory(tenantId, issue, `PR #${pr.number} merged (magic word)`);
          await this.notifyGit(tenantId, issue, 'pm.github.pr_merged', `closed by PR #${pr.number} (magic word)`);
        }
      }
    }
  }

  private async onPush(tenantId: string, repo: string, commits: Array<{ id: string; message: string; url?: string }>) {
    for (const commit of commits.slice(0, 20)) {
      const issues = await this.resolveIssues(tenantId, parseKeys(commit.message));
      const sha = commit.id.slice(0, 7);
      const firstLine = (commit.message ?? '').split('\n')[0]!.slice(0, 60);
      for (const issue of issues) {
        await this.attachLink(tenantId, issue, {
          kind: 'commit',
          ref: sha,
          label: `${sha} ${firstLine}`,
          state: 'open',
          repo,
          url: commit.url,
        });
      }
    }
  }
}
