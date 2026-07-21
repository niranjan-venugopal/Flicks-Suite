import { HttpException, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { syncMutations } from '@flicks/db/schema';
import type { PmMutationItem, PmMutationResultItem, PmSyncTable } from '@flicks/shared/pm';
import { DatabaseService } from '../../../core/database/database.service';
import { PmIssuesService } from '../issues.service';
import { PmSyncGateway } from '../../../gateways/pm-sync.gateway';
import { PmSyncService } from './sync.service';

/**
 * FSE mutation executor (PRD v6 §3.5). Per item: idempotency check against
 * sync_mutations → delegate to the SAME domain-service method the REST path
 * uses (validation/permissions/history/events written once) → record the
 * ledger row → per-item status + authoritative rows. After the batch, one
 * `{seq}` ping to the tenant room (direct post-commit — NOT via the 2s
 * dispatcher; the <1s propagation budget depends on this).
 *
 * Rejections roll back ONLY their item (each item runs in its own tenant tx —
 * matching client semantics: every queued mutation is independent).
 */
@Injectable()
export class PmMutationExecutor {
  private readonly logger = new Logger(PmMutationExecutor.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly issues: PmIssuesService,
    private readonly sync: PmSyncService,
    private readonly gateway: PmSyncGateway,
  ) {}

  async execute(
    tenantId: string,
    userId: string,
    items: PmMutationItem[],
    role?: string,
  ): Promise<{
    results: PmMutationResultItem[];
    latest_seq: number;
  }> {
    // §16 — auditors NEVER mutate, regardless of any grant row. Rejected
    // before touching the ledger so replays stay cheap.
    if (role === 'auditor') {
      return {
        results: items.map((i) => ({
          clientMutationId: i.clientMutationId,
          status: 'rejected' as const,
          errorCode: 'E403:auditor seats are read-only',
        })),
        latest_seq: await this.sync.latestSeq(),
      };
    }

    const results: PmMutationResultItem[] = [];
    let anyApplied = false;

    for (const item of items) {
      // Idempotency: an already-recorded clientMutationId is a no-op replay.
      const seen = await this.db.withTenant(
        tenantId,
        (tx) =>
          tx
            .select({ status: syncMutations.status, error_code: syncMutations.error_code })
            .from(syncMutations)
            .where(
              and(
                eq(syncMutations.tenant_id, tenantId),
                eq(syncMutations.user_id, userId),
                eq(syncMutations.client_mutation_id, item.clientMutationId),
              ),
            )
            .limit(1),
        userId,
      );
      if (seen.length) {
        results.push({
          clientMutationId: item.clientMutationId,
          status: 'duplicate',
          errorCode: seen[0]!.error_code ?? undefined,
        });
        continue;
      }

      try {
        const rows = await this.applyOp(tenantId, userId, item);
        await this.ledger(tenantId, userId, item.clientMutationId, 'applied', null);
        results.push({ clientMutationId: item.clientMutationId, status: 'applied', rows });
        anyApplied = true;
      } catch (err) {
        const code =
          err instanceof HttpException
            ? `E${err.getStatus()}`
            : 'E500';
        const message = err instanceof Error ? err.message : String(err);
        await this.ledger(tenantId, userId, item.clientMutationId, 'rejected', code).catch(() => undefined);
        results.push({
          clientMutationId: item.clientMutationId,
          status: 'rejected',
          errorCode: `${code}:${message.slice(0, 140)}`,
        });
        this.logger.warn(`pm mutate rejected op=${item.op} user=${userId}: ${message}`);
      }
    }

    const latest = await this.sync.latestSeq();
    if (anyApplied) this.gateway.emitSeq(tenantId, latest);
    return { results, latest_seq: latest };
  }

  private async ledger(
    tenantId: string,
    userId: string,
    clientMutationId: string,
    status: 'applied' | 'rejected',
    errorCode: string | null,
  ) {
    await this.db.withTenant(
      tenantId,
      (tx) =>
        tx
          .insert(syncMutations)
          .values({
            tenant_id: tenantId,
            user_id: userId,
            client_mutation_id: clientMutationId,
            status,
            error_code: errorCode,
          })
          .onConflictDoNothing(),
      userId,
    );
  }

  /** Op registry → domain services. Returns authoritative rows keyed by table. */
  private async applyOp(
    tenantId: string,
    userId: string,
    item: PmMutationItem,
  ): Promise<Partial<Record<PmSyncTable, Record<string, unknown>[]>>> {
    const f = (item.fields ?? {}) as Record<string, never>;
    switch (item.op) {
      case 'issue.create': {
        const res = await this.issues.create(tenantId, userId, { ...(f as object), id: item.id } as never);
        return { pm_issues: [res.data as unknown as Record<string, unknown>] };
      }
      case 'issue.update': {
        const res = await this.issues.update(tenantId, userId, item.id, f);
        return { pm_issues: [res.data as unknown as Record<string, unknown>] };
      }
      case 'issue.move_state': {
        const res = await this.issues.moveState(tenantId, userId, item.id, f['state_id']);
        return { pm_issues: [res.data as unknown as Record<string, unknown>] };
      }
      case 'issue.set_priority': {
        const res = await this.issues.setPriority(tenantId, userId, item.id, Number(f['priority']));
        return { pm_issues: [res.data as unknown as Record<string, unknown>] };
      }
      case 'issue.assign': {
        const res = await this.issues.assign(tenantId, userId, item.id, f['assignee_user_id'] ?? null);
        return { pm_issues: [res.data as unknown as Record<string, unknown>] };
      }
      case 'issue.rank': {
        const res = await this.issues.rank(tenantId, userId, item.id, {
          rank_field: f['rank_field'],
          rank: f['rank'],
        });
        return { pm_issues: [res.data as unknown as Record<string, unknown>] };
      }
      case 'issue.set_labels': {
        await this.issues.setLabels(tenantId, userId, item.id, (f['label_ids'] as string[]) ?? []);
        return {};
      }
      case 'issue.relate': {
        await this.issues.relate(tenantId, userId, item.id, {
          related_issue_id: f['related_issue_id'],
          type: f['type'],
        });
        return {};
      }
      case 'issue.unrelate': {
        await this.issues.unrelate(tenantId, userId, item.id, f['related_issue_id'], f['type']);
        return {};
      }
      case 'issue.subscribe': {
        await this.issues.setSubscription(tenantId, userId, item.id, true);
        return {};
      }
      case 'issue.unsubscribe': {
        await this.issues.setSubscription(tenantId, userId, item.id, false);
        return {};
      }
      case 'issue.delete': {
        const res = await this.issues.softDelete(tenantId, userId, item.id);
        return { pm_issues: [res.data as unknown as Record<string, unknown>] };
      }
      case 'issue.restore': {
        const res = await this.issues.restore(tenantId, userId, item.id);
        return { pm_issues: [res.data as unknown as Record<string, unknown>] };
      }
      case 'issue.move_team': {
        const res = await this.issues.moveTeam(tenantId, userId, item.id, f['team_id']);
        return { pm_issues: [res.data as unknown as Record<string, unknown>] };
      }
      case 'comment.create': {
        // item.id is the client-minted COMMENT id; issue in fields.
        await this.issues.createComment(tenantId, userId, f['issue_id'], {
          id: item.id,
          body: f['body'],
          parent_comment_id: f['parent_comment_id'] ?? null,
        });
        return {};
      }
      default:
        throw new HttpException(`Unsupported op ${item.op}`, 400);
    }
  }
}
