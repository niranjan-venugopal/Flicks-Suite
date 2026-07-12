import 'dotenv/config';
import * as crypto from 'crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, dbAdmin, withTenant } from '@flicks/db';
import {
  apiKeys,
  domainEvents,
  memberships,
  tenants,
  users,
  webhookDeliveries,
  webhookEndpoints,
} from '@flicks/db/schema';
import { DomainEventsService } from '../core/events/domain-events.service';
import { ApiKeysService } from '../modules/public-api/api-keys.service';
import { ApiKeyGuard } from '../modules/public-api/api-key.guard';
import { WebhooksService } from '../modules/webhooks/webhooks.service';
import { AppCryptoService } from '../core/crypto/app-crypto.service';
// Mock only the network call; assertPublicHttpUrl/isPrivateAddress stay real.
jest.mock('../core/security/ssrf.util', () => {
  const actual = jest.requireActual('../core/security/ssrf.util');
  return { __esModule: true, ...actual, ssrfSafePostJson: jest.fn() };
});
import {
  assertPublicHttpUrl,
  isPrivateAddress,
  ssrfSafePostJson,
} from '../core/security/ssrf.util';
const ssrfPostMock = ssrfSafePostJson as jest.Mock;
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';

/**
 * PRD v5 Sprint 24 — architecture evolution. Real-Postgres integration for the
 * transactional outbox, API keys, and outbound webhooks; unit coverage for the
 * SSRF guard, HMAC delivery signature, and per-purpose crypto.
 */

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const emitter = new EventEmitter2({ wildcard: true, delimiter: '.' });
const events = new DomainEventsService(dbAdmin as never, emitter);
const apiKeysSvc = new ApiKeysService(dbAdmin as never, audit);
const cryptoSvc = new AppCryptoService({
  get: (key: string) => (key === 'WEBHOOK_SECRET_ENC_KEY' ? 'test-webhook-enc-key' : undefined),
} as never);
const webhooks = new WebhooksService(dbAdmin as never, cryptoSvc, audit);

let tenantId: string;
let userId: string;

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `EvoCo${rid()}`, slug: `evo-${rid()}-${Date.now()}`, status: 'active' })
    .returning();
  tenantId = t!.id;
  const [u] = await dbAdmin
    .insert(users)
    .values({ email: `evo-${rid()}@test.test`, full_name: 'Evo Owner', status: 'active' })
    .returning();
  userId = u!.id;
  // Owner membership so the endpoint-disabled notification has a recipient.
  await dbAdmin
    .insert(memberships)
    .values({ tenant_id: tenantId, user_id: userId, role: 'owner', status: 'active' });
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  await dbAdmin.delete(users).where(eq(users.id, userId));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('Domain-event outbox (PRD v5 §2.2)', () => {
  it('publish persists the outbox row and fires the in-process lane', async () => {
    const received: unknown[] = [];
    emitter.on('domain.invoice.created', (e) => received.push(e));
    const id = await events.publish({
      name: 'invoice.created',
      tenantId,
      actorUserId: userId,
      payload: { invoice_id: 'x', currency: 'INR' },
    });
    expect(id).toBeTruthy();
    const [row] = await dbAdmin.select().from(domainEvents).where(eq(domainEvents.id, id!));
    expect(row!.event_name).toBe('invoice.created');
    expect(row!.tenant_id).toBe(tenantId);
    expect(row!.dispatched_at).toBeNull(); // dispatcher hasn't run
    expect(received).toHaveLength(1);
    expect((received[0] as { payload: { invoice_id: string } }).payload.invoice_id).toBe('x');
  });

  it('rejects event names outside the catalog (fail-fast in test env)', async () => {
    await expect(
      events.publish({ name: 'crm.made.up' as never, tenantId }),
    ).rejects.toThrow(/catalog/);
  });

  it('rides the app-role transaction: INSERT allowed for own tenant, SELECT denied (outbox RLS)', async () => {
    // The whole point of the outbox: the event commits WITH the state change,
    // inside the caller's app-role tenant transaction.
    const id = await withTenant(tenantId, async (tx) =>
      events.publish({ name: 'invoice.sent', tenantId, payload: { invoice_id: 'y' } }, tx),
    );
    const [row] = await dbAdmin.select().from(domainEvents).where(eq(domainEvents.id, id!));
    expect(row).toBeDefined();

    // App role must NOT read the outbox (service-layer only).
    await expect(
      withTenant(tenantId, (tx) => tx.select().from(domainEvents).limit(1)),
    ).rejects.toThrow();

    // App role must NOT insert for another tenant (WITH CHECK policy).
    await expect(
      withTenant(tenantId, (tx) =>
        tx.insert(domainEvents).values({
          tenant_id: '00000000-0000-0000-0000-000000000001',
          event_name: 'invoice.created',
        }),
      ),
    ).rejects.toThrow();
  });

  it('dispatcher batch: claims undispatched rows, enqueues, stamps dispatched_at (idempotent)', async () => {
    const { DomainEventsDispatcher } = await import('../core/events/domain-events.dispatcher');
    const enqueued: Array<{ name: string; jobId: string }> = [];
    const queueStub = {
      add: async (name: string, _data: unknown, opts: { jobId: string }) => {
        enqueued.push({ name, jobId: opts.jobId });
        return {};
      },
    };
    const dispatcher = new DomainEventsDispatcher(dbAdmin as never, queueStub as never);

    process.env.WORKER_MODE = 'true';
    try {
      const before = enqueued.length;
      await dispatcher.tick();
      expect(enqueued.length).toBeGreaterThan(before); // drained our published rows
      const undispatched = await dbAdmin
        .select({ id: domainEvents.id })
        .from(domainEvents)
        .where(and(eq(domainEvents.tenant_id, tenantId), isNull(domainEvents.dispatched_at)));
      expect(undispatched).toHaveLength(0);

      // Second tick drains nothing new — dispatch is once-only.
      const afterFirst = enqueued.length;
      await dispatcher.tick();
      expect(enqueued.length).toBe(afterFirst);
    } finally {
      process.env.WORKER_MODE = 'false';
    }
  });

  it('API process never drains (WORKER_MODE gate)', async () => {
    const { DomainEventsDispatcher } = await import('../core/events/domain-events.dispatcher');
    await events.publish({ name: 'invoice.paid', tenantId, payload: { invoice_id: 'z' } });
    const enqueued: unknown[] = [];
    const dispatcher = new DomainEventsDispatcher(
      dbAdmin as never,
      { add: async (n: string) => (enqueued.push(n), {}) } as never,
    );
    process.env.WORKER_MODE = 'false';
    await dispatcher.tick();
    expect(enqueued).toHaveLength(0);
    // Clean up the stranded row so later assertions stay tight.
    await dbAdmin
      .update(domainEvents)
      .set({ dispatched_at: new Date() })
      .where(and(eq(domainEvents.tenant_id, tenantId), isNull(domainEvents.dispatched_at)));
  });

  it('publishers: InvoicesService.create emits invoice.created through the REAL outbox', async () => {
    const { InvoicesService } = await import('../modules/invoicing/invoices.service');
    const { NumberingService } = await import('../modules/invoicing/numbering.service');
    const { CustomersService } = await import('../modules/invoicing/customers.service');
    const numbering = new NumberingService(dbSvc, audit);
    const configStub = { get: (_: string, fb?: unknown) => fb } as never;
    const notificationsStub = { sendEmail: async () => true } as never;
    const orgFinancialStub = { resolveForInvoice: async () => null } as never;
    const invoicesSvc = new InvoicesService(
      dbSvc, audit, numbering, configStub, notificationsStub, orgFinancialStub, events,
    );
    const customersSvc = new CustomersService(dbSvc, audit);
    const customer = await customersSvc.create(
      { display_name: 'Evo Customer', customer_type: 'business' } as never,
      userId,
      tenantId,
    );
    const today = new Date().toISOString().slice(0, 10);
    const inv = await invoicesSvc.create(
      {
        customer_id: customer.data.id,
        invoice_date: today,
        due_date: today,
        line_items: [{ item_name: 'Consulting', quantity: '1', rate: '1000' }],
      } as never,
      userId,
      tenantId,
    );
    const rows = await dbAdmin
      .select()
      .from(domainEvents)
      .where(and(eq(domainEvents.tenant_id, tenantId), eq(domainEvents.event_name, 'invoice.created')));
    const match = rows.find(
      (r) => (r.payload as { invoice_id?: string }).invoice_id === inv.data.id,
    );
    expect(match).toBeDefined();
    // Payload discipline: ids/enums/amounts only.
    expect(JSON.stringify(match!.payload)).not.toContain('@');
  });
});

describe('API keys + public API (PRD v5 §11)', () => {
  let plainKey: string;
  let keyId: string;

  it('create returns the key ONCE; only hash+prefix persist', async () => {
    const res = await apiKeysSvc.create(tenantId, userId, {
      name: 'Zapier',
      scopes: ['crm:read', 'directory:read'],
    });
    plainKey = res.data.key;
    keyId = res.data.id;
    expect(plainKey.startsWith('flk_live_')).toBe(true);
    const [row] = await dbAdmin.select().from(apiKeys).where(eq(apiKeys.id, keyId));
    expect(row!.key_hash).toBe(crypto.createHash('sha256').update(plainKey).digest('hex'));
    expect(row!.key_prefix.endsWith('…')).toBe(true);
    expect(JSON.stringify(row!.key_prefix)).not.toContain(plainKey.slice(15));
  });

  it('verify: valid key → tenant context; unknown/revoked → null; bad scopes rejected at create', async () => {
    const ctx = await apiKeysSvc.verify(plainKey);
    expect(ctx?.tenantId).toBe(tenantId);
    expect(ctx?.scopes).toContain('crm:read');
    expect(await apiKeysSvc.verify('flk_live_nonsense')).toBeNull();
    await expect(
      apiKeysSvc.create(tenantId, userId, { name: 'Bad', scopes: ['root:everything'] }),
    ).rejects.toThrow(/Unknown scopes/);
  });

  it('guard: enforces scopes and the 120/min Redis window; key yields ONLY its own tenant', async () => {
    let count = 0;
    const redisStub = {
      incr: async () => ++count,
      expire: async () => 1,
    };
    const reflectorStub = {
      getAllAndOverride: () => ['crm:write'], // handler requires a scope the key lacks
    };
    const guard = new ApiKeyGuard(reflectorStub as never, apiKeysSvc, redisStub as never);
    const ctxFor = (auth?: string) =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: auth } }) }),
        getHandler: () => ({}),
        getClass: () => ({}),
      }) as never;

    await expect(guard.canActivate(ctxFor(undefined))).rejects.toThrow(/API key/);
    await expect(guard.canActivate(ctxFor(`Bearer ${plainKey}`))).rejects.toThrow(/missing scope/);

    // Scope satisfied → passes and pins the key's OWN tenant.
    const okGuard = new ApiKeyGuard(
      { getAllAndOverride: () => ['crm:read'] } as never,
      apiKeysSvc,
      redisStub as never,
    );
    const req: { headers: Record<string, string>; apiKey?: { tenantId: string } } = {
      headers: { authorization: `Bearer ${plainKey}` },
    };
    const passCtx = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as never;
    expect(await okGuard.canActivate(passCtx)).toBe(true);
    expect(req.apiKey!.tenantId).toBe(tenantId); // cross-tenant isolation root

    // Blow the window → 429.
    count = 500;
    await expect(okGuard.canActivate(passCtx)).rejects.toThrow(/rate limit/);
  });

  it('revoke kills the key immediately', async () => {
    await apiKeysSvc.revoke(tenantId, userId, keyId);
    expect(await apiKeysSvc.verify(plainKey)).toBeNull();
  });

  it('RLS posture: app role fully denied on api_keys', async () => {
    await expect(
      withTenant(tenantId, (tx) => tx.select().from(apiKeys).limit(1)),
    ).rejects.toThrow();
  });
});

describe('SSRF guard (PRD v5 §11/§13)', () => {
  it('flags private/reserved space (incl. NAT64/IPv4-compat), passes public addresses', () => {
    for (const bad of [
      '10.1.2.3', '192.168.1.1', '127.0.0.1', '169.254.169.254', '172.20.0.5',
      '100.64.0.9', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:10.0.0.1',
      '64:ff9b::7f00:1', // NAT64-encoded 127.0.0.1
      '::127.0.0.1', // IPv4-compatible (dotted) loopback
    ]) {
      expect(isPrivateAddress(bad)).toBe(true);
    }
    for (const ok of ['8.8.8.8', '1.1.1.1', '52.95.116.115', '2606:4700:4700::1111']) {
      expect(isPrivateAddress(ok)).toBe(false);
    }
  });

  it('assertPublicHttpUrl rejects private literals, credentials, and non-http schemes', async () => {
    await expect(assertPublicHttpUrl('http://127.0.0.1/hook')).rejects.toThrow(/private/);
    await expect(assertPublicHttpUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/private/);
    await expect(assertPublicHttpUrl('ftp://example.com/x')).rejects.toThrow(/http/);
    await expect(assertPublicHttpUrl('https://user:pass@example.com/x')).rejects.toThrow(/Credentials/);
    await expect(assertPublicHttpUrl('not a url')).rejects.toThrow(/Invalid/);
    await expect(assertPublicHttpUrl('http://8.8.8.8/hook')).resolves.toBeUndefined();
  });
});

describe('Outbound webhooks (PRD v5 §11)', () => {
  let endpointId: string;
  let plainSecret: string;

  it('create: validates events + SSRF, reveals whsec once, stores it encrypted', async () => {
    await expect(
      webhooks.create(tenantId, userId, { url: 'http://127.0.0.1/x', events: ['invoice.paid'] }),
    ).rejects.toThrow(/private/);
    await expect(
      webhooks.create(tenantId, userId, { url: 'http://8.8.8.8/x', events: ['nope.event'] }),
    ).rejects.toThrow(/Unknown events/);

    const res = await webhooks.create(tenantId, userId, {
      url: 'http://8.8.8.8/hooks',
      events: ['invoice.paid', 'crm.deal.won'],
    });
    endpointId = res.data.id;
    plainSecret = (res.data as { secret: string }).secret;
    expect(plainSecret.startsWith('whsec_')).toBe(true);
    const [row] = await dbAdmin
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, endpointId));
    expect(row!.secret_encrypted).not.toBe(plainSecret); // AES-256-GCM at rest
    expect(cryptoSvc.decrypt(row!.secret_encrypted, 'webhook')).toBe(plainSecret);
    // list() never serializes the secret.
    const listed = await webhooks.list(tenantId);
    expect(JSON.stringify(listed)).not.toContain('secret');
  });

  it('delivery: signs t=,v1= HMAC; success resets strikes; exhaustion disables at 20 + notifies', async () => {
    const { WebhookDeliveryProcessor } = await import('../modules/webhooks/webhook-delivery.processor');
    const notified: string[] = [];
    const notificationsStub = {
      createInAppNotification: async (_u: string, type: string) => {
        notified.push(type);
      },
    } as never;
    const processor = new WebhookDeliveryProcessor(dbAdmin as never, cryptoSvc, notificationsStub);

    const envelope = {
      id: crypto.randomUUID(),
      name: 'invoice.paid',
      tenantId,
      actorUserId: null,
      occurredAt: new Date().toISOString(),
      payload: { invoice_id: 'inv1' },
    };
    const mkDelivery = async () => {
      const [d] = await dbAdmin
        .insert(webhookDeliveries)
        .values({ tenant_id: tenantId, endpoint_id: endpointId, event_name: 'invoice.paid' })
        .returning({ id: webhookDeliveries.id });
      return d!.id;
    };

    // Success path — capture the signed request (delivery uses the SSRF-safe
    // POST helper, mocked here) and verify the HMAC over the exact body sent.
    let captured: { url: string; headers: Record<string, string>; body: string } | null = null;
    ssrfPostMock.mockReset();
    ssrfPostMock.mockImplementation(async (url: string, body: string, headers: Record<string, string>) => {
      captured = { url, body, headers };
      return { status: 200 };
    });

    const okId = await mkDelivery();
    await processor.process({
      data: { deliveryId: okId, event: envelope },
      attemptsMade: 0,
      opts: { attempts: 5 },
    } as never);
    const [okRow] = await dbAdmin
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, okId));
    expect(okRow!.status).toBe('success');
    const sig = captured!.headers['X-Flicks-Signature'];
    const [tPart, vPart] = sig.split(',');
    const t = tPart!.split('=')[1];
    const expected = crypto
      .createHmac('sha256', plainSecret)
      .update(`${t}.${captured!.body}`)
      .digest('hex');
    expect(vPart!.split('=')[1]).toBe(expected);

    // Failure on the FINAL attempt marks exhausted and strikes the endpoint.
    ssrfPostMock.mockResolvedValue({ status: 500 });
    // Pre-set strikes to 19 so this exhaustion crosses the disable threshold.
    await dbAdmin
      .update(webhookEndpoints)
      .set({ consecutive_failures: 19 })
      .where(eq(webhookEndpoints.id, endpointId));
    const failId = await mkDelivery();
    await expect(
      processor.process({
        data: { deliveryId: failId, event: envelope },
        attemptsMade: 4,
        opts: { attempts: 5 },
      } as never),
    ).rejects.toThrow(/HTTP 500/);
    const [failRow] = await dbAdmin
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, failId));
    expect(failRow!.status).toBe('exhausted');
    const [ep] = await dbAdmin
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, endpointId));
    expect(ep!.active).toBe(false);
    expect(ep!.disabled_reason).toContain('consecutive');
    expect(notified).toContain('webhooks.endpoint_disabled');
  });

  it('fan-out is idempotent: one delivery per (endpoint, event) even on redelivery', async () => {
    const evId = crypto.randomUUID();
    const ins = () =>
      dbAdmin
        .insert(webhookDeliveries)
        .values({ tenant_id: tenantId, endpoint_id: endpointId, event_id: evId, event_name: 'invoice.paid' })
        .onConflictDoNothing({
          target: [webhookDeliveries.endpoint_id, webhookDeliveries.event_id],
        })
        .returning({ id: webhookDeliveries.id });
    const first = await ins();
    const second = await ins(); // simulated redelivery of the same fan-out job
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0); // no duplicate row → no duplicate POST
  });

  it('re-enabling resets strikes; RLS posture: app role fully denied', async () => {
    const res = await webhooks.update(tenantId, userId, endpointId, { active: true });
    expect((res.data as { consecutive_failures: number }).consecutive_failures).toBe(0);
    await expect(
      withTenant(tenantId, (tx) => tx.select().from(webhookEndpoints).limit(1)),
    ).rejects.toThrow();
    await expect(
      withTenant(tenantId, (tx) => tx.select().from(webhookDeliveries).limit(1)),
    ).rejects.toThrow();
  });
});

describe('Reserved tenant slugs (PRD v5 §1)', () => {
  it('checkSlug refuses every reserved platform host', async () => {
    const { OnboardingService } = await import('../modules/onboarding/onboarding.service');
    const svc = new OnboardingService(
      dbAdmin as never,
      audit as never,
      { track: () => {} } as never,
      { sendEmail: async () => true } as never,
      { get: (_: string, fb?: unknown) => fb } as never,
    );
    for (const slug of ['app', 'api', 'mail', 'in', 'admin', 'www']) {
      expect((await svc.checkSlug(slug)).available).toBe(false);
    }
    expect((await svc.checkSlug(`ok-${rid()}`)).available).toBe(true);
  });
});
