/**
 * Founder round P · R5 — the project icon library (API slice).
 *
 * The founder's ask: "add Premium Logo's like apple do or add an image. Both
 * can't be added … Add more icons." The decision: a crisp lucide glyph drawn
 * white on a colour tile, OR an uploaded image — never both at once.
 *
 * What this suite pins (service-level against the real Postgres, mirroring
 * founder-roundE.spec.ts):
 *  1. `icon` is either `lucide:<name>` or a legacy emoji; `color` is #RRGGBB.
 *     Both are checked at BOTH doors — the REST DTOs under the real global
 *     ValidationPipe AND the service itself, which is the only guard on the
 *     sync door (PmMutationExecutor calls create/update directly).
 *  2. Exclusivity: choosing any icon on a project that has an uploaded logo
 *     clears logo_key in the same UPDATE (the row handed back already has
 *     logo_url null), deletes the previous image after the tx and audits it
 *     like removeLogo. The row is read FOR UPDATE, so an upload racing the
 *     icon write lands after it instead of orphaning its new image.
 *  3. uploadLogo keeps icon + colour stored (the image merely wins while
 *     present); removeLogo leaves them alone so the tile comes back.
 *  4. null = clear on update (colour), and a null icon never touches the logo.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { db, dbAdmin } from '@flicks/db';
import { tenants, users, memberships, pmTeams, pmProjects, domainEvents, auditLog } from '@flicks/db/schema';
import type { UserRole } from '@flicks/shared/types';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { DomainEventsService } from '../core/events/domain-events.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { PmTeamsService } from '../modules/pm/teams.service';
import { PmIssuesService } from '../modules/pm/issues.service';
import { PmProjectsService, PROJECT_COLOR_RE, PROJECT_ICON_RE } from '../modules/pm/projects.service';
import { PmVisibilityService } from '../modules/pm/sync/visibility.service';
import { PmSyncService } from '../modules/pm/sync/sync.service';
import { PmMutationExecutor } from '../modules/pm/sync/mutation-executor.service';
import { CreateProjectDto, UpdateProjectDto } from '../modules/pm/pm.controller';

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const emitter = new EventEmitter2();
const domainEventsSvc = new DomainEventsService(dbAdmin as never, emitter);
const notificationsSvc = new NotificationsService(db as never, dbAdmin as never, new ConfigService(), emitter);
const visibility = new PmVisibilityService(dbSvc);

// One media stub for every consumer: pure, deterministic, no R2.
const mediaStub = {
  servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l),
  processImage: jest.fn(async (_buf: Buffer, prefix: string) => ({
    key256: `${prefix}/${rid()}_256.webp`,
    key64: `${prefix}/${rid()}_64.webp`,
  })),
  deleteImage: jest.fn(async () => undefined),
};

const teamsSvc = new PmTeamsService(dbSvc, audit, domainEventsSvc, visibility, mediaStub as never);
const issuesSvc = new PmIssuesService(dbSvc, audit, domainEventsSvc, notificationsSvc, visibility);
const projectsSvc = new PmProjectsService(dbSvc, audit, domainEventsSvc, visibility, mediaStub as never);
const syncSvc = new PmSyncService(dbSvc, dbAdmin as never, visibility, teamsSvc, mediaStub as never);
const executor = new PmMutationExecutor(dbSvc, issuesSvc, projectsSvc, syncSvc, { emitSeq: jest.fn() } as never);

// The real global pipe (main.ts) over the exported DTO classes.
const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  transformOptions: { enableImplicitConversion: true },
});
const createMeta = { type: 'body' as const, metatype: CreateProjectDto };
const updateMeta = { type: 'body' as const, metatype: UpdateProjectDto };

type ProjectFace = { id: string; icon: string | null; color: string | null; logo_url: string | null };

// Any letter-case of the `lucide:` prefix must be a well-formed name (the web
// would otherwise draw it as literal text); C0 controls would reach Postgres
// and come back as a 500 / E500 instead of a 400.
const INVALID_ICONS = [
  'lucide:Rocket',
  'Lucide:Rocket',
  'LUCIDE:rocket',
  `lucide:${'a'.repeat(30)}`,
  'x'.repeat(20),
  'lucide:a b',
  '\u0000',
  '\u0001',
  '\u007f',
];
const INVALID_COLORS = ['red', '#FFF', '#GGGGGG'];

let tenantId: string;
let ownerId: string;
let teamId: string;
const trackedUsers: string[] = [];

async function rowOf(projectId: string) {
  const [row] = await dbAdmin.select().from(pmProjects).where(eq(pmProjects.id, projectId));
  return row!;
}

async function auditRows(projectId: string, action: string) {
  return dbAdmin
    .select({ actor: auditLog.actor_user_id })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, tenantId), eq(auditLog.action, action), eq(auditLog.resource_id, projectId)));
}

async function mkProject(input: Partial<Parameters<typeof projectsSvc.create>[2]> = {}) {
  return (await projectsSvc.create(tenantId, ownerId, { name: `Icon ${rid()}`, team_ids: [teamId], ...input })).data as ProjectFace;
}

/** The sync door: one `project.update` item straight through the executor. */
async function syncUpdate(projectId: string, fields: Record<string, unknown>) {
  const res = await executor.execute(tenantId, ownerId, [
    { clientMutationId: crypto.randomUUID(), op: 'project.update' as const, id: projectId, fields },
  ]);
  return res.results[0]!;
}

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `RP5 Studio ${rid()}`, slug: `rp5-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  tenantId = t!.id;

  const mk = async (role: UserRole, label: string) => {
    const [u] = await dbAdmin
      .insert(users)
      .values({ email: `rp5-${label}-${rid()}@t.test`, full_name: `RP5 ${label}`, status: 'active' })
      .returning();
    await dbAdmin.insert(memberships).values({ tenant_id: tenantId, user_id: u!.id, role, status: 'active' });
    trackedUsers.push(u!.id);
    return u!.id;
  };
  ownerId = await mk('owner', 'owner');

  await teamsSvc.ensureWorkspace(tenantId, ownerId);
  const [team] = await dbAdmin.select().from(pmTeams).where(eq(pmTeams.tenant_id, tenantId));
  teamId = team!.id;
});

afterAll(async () => {
  await dbAdmin.delete(domainEvents).where(eq(domainEvents.tenant_id, tenantId));
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  for (const id of trackedUsers) await dbAdmin.delete(users).where(eq(users.id, id));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('R5-1 — the stored contract: lucide glyph or legacy emoji, #RRGGBB colour', () => {
  it('create with a lucide icon + colour stores both and hands them back', async () => {
    const p = await mkProject({ icon: 'lucide:rocket', color: '#DC2626' });
    expect(p.icon).toBe('lucide:rocket');
    expect(p.color).toBe('#DC2626');
    expect(p.logo_url).toBeNull();
    const row = await rowOf(p.id);
    expect(row.icon).toBe('lucide:rocket');
    expect(row.color).toBe('#DC2626');
    expect(row.logo_key).toBeNull();
  });

  it('a legacy emoji keeps working (old projects, old clients)', async () => {
    const p = await mkProject({ icon: '🚀' });
    expect(p.icon).toBe('🚀');
    expect((await rowOf(p.id)).icon).toBe('🚀');
    // A multi-code-point emoji (wrench + variation selector) is still one short face.
    const q = await mkProject({ icon: '🛠️', color: '#2563EB' });
    expect(q.icon).toBe('🛠️');
  });

  it('nothing given → icon and colour stay null (the web draws the default tile)', async () => {
    const p = await mkProject();
    expect(p.icon).toBeNull();
    expect(p.color).toBeNull();
  });

  it('the regexes themselves: the lucide branch is lower-case kebab ≤ 24, the emoji branch is ≤ 16 non-space chars', () => {
    expect(PROJECT_ICON_RE.test('lucide:folder-kanban')).toBe(true);
    expect(PROJECT_ICON_RE.test(`lucide:${'a'.repeat(24)}`)).toBe(true);
    expect(PROJECT_ICON_RE.test(`lucide:${'a'.repeat(25)}`)).toBe(false);
    expect(PROJECT_ICON_RE.test('lucide:')).toBe(false);
    expect(PROJECT_ICON_RE.test('🎯')).toBe(true);
    expect(PROJECT_ICON_RE.test('x'.repeat(16))).toBe(true);
    expect(PROJECT_ICON_RE.test('x'.repeat(17))).toBe(false);
    expect(PROJECT_ICON_RE.test('')).toBe(false);
    expect(PROJECT_ICON_RE.test('a b')).toBe(false);
    // Multi-code-point emoji ride on format characters (ZWJ, VS16) — still one face.
    expect(PROJECT_ICON_RE.test('👨‍👩‍👧')).toBe(true);
    expect(PROJECT_ICON_RE.test('🏳️‍🌈')).toBe(true);
    for (const bad of INVALID_ICONS) expect(PROJECT_ICON_RE.test(bad)).toBe(false);
    expect(PROJECT_COLOR_RE.test('#DC2626')).toBe(true);
    expect(PROJECT_COLOR_RE.test('#dc2626')).toBe(true);
    for (const bad of INVALID_COLORS) expect(PROJECT_COLOR_RE.test(bad)).toBe(false);
  });
});

describe('R5-2 — icon XOR image', () => {
  it('choosing an icon on a project with an uploaded logo drops the logo in the same write and deletes the image after the tx', async () => {
    const p = await mkProject({ icon: '🎯', color: '#7C3AED' });
    const uploaded = await projectsSvc.uploadLogo(tenantId, ownerId, p.id, Buffer.from('fake-image'));
    expect((uploaded.data as ProjectFace).logo_url).toMatch(/^signed:tenants\//);
    const afterUpload = await rowOf(p.id);
    const oldKey = afterUpload.logo_key;
    expect(oldKey).toMatch(/^tenants\/.*\/pm-projects\//);
    const stampedByUpload = afterUpload.logo_updated_at!;
    expect(stampedByUpload).not.toBeNull();
    expect(await auditRows(p.id, 'pm.project.logo_removed')).toHaveLength(0);

    mediaStub.deleteImage.mockClear();
    const res = await projectsSvc.update(tenantId, ownerId, p.id, { icon: 'lucide:rocket' });
    const face = res.data as ProjectFace;
    expect(face.icon).toBe('lucide:rocket');
    expect(face.color).toBe('#7C3AED'); // colour untouched
    expect(face.logo_url).toBeNull(); // the client's row is already image-free
    expect('logo_key' in (res.data as Record<string, unknown>)).toBe(false);

    const row = await rowOf(p.id);
    expect(row.logo_key).toBeNull();
    // The icon write itself re-stamps logo_updated_at (not just the upload before it).
    expect(row.logo_updated_at!.getTime()).toBeGreaterThan(stampedByUpload.getTime());
    expect(mediaStub.deleteImage).toHaveBeenCalledTimes(1);
    expect(mediaStub.deleteImage).toHaveBeenCalledWith(oldKey);
    // Same audit trail as removeLogo — the log says who swapped the image for an icon.
    const audits = await auditRows(p.id, 'pm.project.logo_removed');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actor).toBe(ownerId);
  });

  it('the same exclusivity holds through the sync door (project.update via the executor)', async () => {
    const p = await mkProject();
    await projectsSvc.uploadLogo(tenantId, ownerId, p.id, Buffer.from('fake-image'));
    const oldKey = (await rowOf(p.id)).logo_key;
    expect(oldKey).not.toBeNull();

    mediaStub.deleteImage.mockClear();
    const r = await syncUpdate(p.id, { icon: 'lucide:target', color: '#059669' });
    expect(r.status).toBe('applied');
    const acked = (r as { rows?: { pm_projects?: ProjectFace[] } }).rows?.pm_projects?.[0];
    expect(acked?.icon).toBe('lucide:target');
    expect(acked?.logo_url).toBeNull();
    expect((await rowOf(p.id)).logo_key).toBeNull();
    expect(mediaStub.deleteImage).toHaveBeenCalledWith(oldKey);
  });

  it('a legacy emoji counts as an icon too — it also drops the logo', async () => {
    const p = await mkProject();
    await projectsSvc.uploadLogo(tenantId, ownerId, p.id, Buffer.from('fake-image'));
    mediaStub.deleteImage.mockClear();
    const res = await projectsSvc.update(tenantId, ownerId, p.id, { icon: '⚡' });
    expect((res.data as ProjectFace).logo_url).toBeNull();
    expect((await rowOf(p.id)).logo_key).toBeNull();
    expect(mediaStub.deleteImage).toHaveBeenCalledTimes(1);
  });

  it('an icon update on a project WITHOUT a logo never calls deleteImage (and writes no logo audit row)', async () => {
    const p = await mkProject({ icon: 'lucide:rocket' });
    mediaStub.deleteImage.mockClear();
    const res = await projectsSvc.update(tenantId, ownerId, p.id, { icon: 'lucide:zap' });
    expect((res.data as ProjectFace).icon).toBe('lucide:zap');
    expect(mediaStub.deleteImage).not.toHaveBeenCalled();
    expect(await auditRows(p.id, 'pm.project.logo_removed')).toHaveLength(0);
  });

  it('an icon write holds the project row: a logo upload racing it lands AFTER the icon write and wins (no orphaned image)', async () => {
    const p = await mkProject({ icon: 'lucide:rocket' });
    await projectsSvc.uploadLogo(tenantId, ownerId, p.id, Buffer.from('fake-image'));
    const oldKey = (await rowOf(p.id)).logo_key!;
    expect(oldKey).not.toBeNull();
    mediaStub.deleteImage.mockClear();

    // Pause update() between its (locked) row read and its UPDATE, at the
    // member check a lead_user_id patch triggers — the exact window where an
    // unlocked read would let a concurrent upload commit a new key that the
    // icon write then nulls out, orphaning the new R2 object.
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let markPaused!: () => void;
    const paused = new Promise<void>((r) => (markPaused = r));
    const svc = projectsSvc as unknown as { assertActiveMember: (...args: unknown[]) => Promise<void> };
    const original = svc.assertActiveMember;
    const spy = jest.spyOn(svc, 'assertActiveMember').mockImplementation(async (...args: unknown[]) => {
      markPaused();
      await released;
      return original.apply(projectsSvc, args);
    });
    // No assertion inside the try: whatever happens, the icon write is
    // released so its tx can never be left open (which would hang the pool).
    let uploadDoneDuringPause = true;
    let upload: Promise<{ data: unknown }> | undefined;
    let iconWrite: Promise<{ data: unknown }> | undefined;
    try {
      iconWrite = projectsSvc.update(tenantId, ownerId, p.id, { icon: 'lucide:zap', lead_user_id: ownerId });
      await paused;
      // The racing upload: its first tx is a plain read (never blocked), the
      // image is processed, then its second tx must wait for the row lock.
      let uploadDone = false;
      upload = projectsSvc.uploadLogo(tenantId, ownerId, p.id, Buffer.from('fake-image-2')).then((r) => {
        uploadDone = true;
        return r;
      });
      await new Promise((r) => setTimeout(r, 400));
      uploadDoneDuringPause = uploadDone;
    } finally {
      release();
      spy.mockRestore();
    }
    await iconWrite;
    const up = await upload!;
    expect(uploadDoneDuringPause).toBe(false); // the upload was blocked behind the icon write

    const row = await rowOf(p.id);
    expect(row.icon).toBe('lucide:zap');
    expect(row.logo_key).not.toBeNull(); // the upload landed after the icon write — image wins while present
    expect(row.logo_key).not.toBe(oldKey);
    expect((up.data as ProjectFace).logo_url).toBe(`signed:${row.logo_key}`);
    // Only the OLD key was ever deleted (by both paths); the live one is never orphaned.
    expect(mediaStub.deleteImage).not.toHaveBeenCalledWith(row.logo_key);
    for (const call of mediaStub.deleteImage.mock.calls as unknown as unknown[][]) expect(call[0]).toBe(oldKey);
  });

  it('uploadLogo keeps icon + colour stored and serves logo_url; removeLogo brings the tile back', async () => {
    const p = await mkProject({ icon: 'lucide:rocket', color: '#DC2626' });
    const up = await projectsSvc.uploadLogo(tenantId, ownerId, p.id, Buffer.from('fake-image'));
    const face = up.data as ProjectFace;
    expect(face.logo_url).toMatch(/^signed:tenants\//);
    expect(face.icon).toBe('lucide:rocket');
    expect(face.color).toBe('#DC2626');
    let row = await rowOf(p.id);
    expect(row.icon).toBe('lucide:rocket');
    expect(row.color).toBe('#DC2626');
    expect(row.logo_key).not.toBeNull();

    const removed = await projectsSvc.removeLogo(tenantId, ownerId, p.id);
    const after = removed.data as ProjectFace;
    expect(after.logo_url).toBeNull();
    expect(after.icon).toBe('lucide:rocket');
    expect(after.color).toBe('#DC2626');
    row = await rowOf(p.id);
    expect(row.logo_key).toBeNull();
    expect(row.icon).toBe('lucide:rocket');
    expect(row.color).toBe('#DC2626');
  });

  it('a colour-only update, or an update of other fields, leaves an uploaded logo alone', async () => {
    const p = await mkProject({ icon: 'lucide:rocket' });
    await projectsSvc.uploadLogo(tenantId, ownerId, p.id, Buffer.from('fake-image'));
    const key = (await rowOf(p.id)).logo_key;
    mediaStub.deleteImage.mockClear();
    const colour = await projectsSvc.update(tenantId, ownerId, p.id, { color: '#0EA5E9' });
    expect((colour.data as ProjectFace).logo_url).toMatch(/^signed:/);
    const renamed = await projectsSvc.update(tenantId, ownerId, p.id, { name: `Renamed ${rid()}` });
    expect((renamed.data as ProjectFace).logo_url).toMatch(/^signed:/);
    expect((await rowOf(p.id)).logo_key).toBe(key);
    expect(mediaStub.deleteImage).not.toHaveBeenCalled();
  });
});

describe('R5-3 — null on update: colour clears, icon null never touches the logo', () => {
  it('color: null clears the colour', async () => {
    const p = await mkProject({ icon: 'lucide:rocket', color: '#DC2626' });
    const res = await projectsSvc.update(tenantId, ownerId, p.id, { color: null });
    expect((res.data as ProjectFace).color).toBeNull();
    expect((res.data as ProjectFace).icon).toBe('lucide:rocket');
    expect((await rowOf(p.id)).color).toBeNull();
  });

  it('icon: null is accepted, clears the icon and leaves logo_key alone', async () => {
    const p = await mkProject({ icon: 'lucide:rocket' });
    await projectsSvc.uploadLogo(tenantId, ownerId, p.id, Buffer.from('fake-image'));
    const key = (await rowOf(p.id)).logo_key;
    mediaStub.deleteImage.mockClear();
    const res = await projectsSvc.update(tenantId, ownerId, p.id, { icon: null });
    expect((res.data as ProjectFace).icon).toBeNull();
    expect((res.data as ProjectFace).logo_url).toMatch(/^signed:/);
    const row = await rowOf(p.id);
    expect(row.icon).toBeNull();
    expect(row.logo_key).toBe(key);
    expect(mediaStub.deleteImage).not.toHaveBeenCalled();
    // The sync door agrees.
    const r = await syncUpdate(p.id, { icon: null });
    expect(r.status).toBe('applied');
    expect((await rowOf(p.id)).logo_key).toBe(key);
  });

  it('the DTO lets null through for both fields on update', async () => {
    const ok = (await pipe.transform({ icon: null, color: null }, updateMeta)) as UpdateProjectDto;
    expect(ok.icon).toBeNull();
    expect(ok.color).toBeNull();
  });
});

describe('R5-4 — invalid values are refused at BOTH doors', () => {
  it('service create / update: bad icons → BadRequest', async () => {
    const p = await mkProject();
    for (const bad of INVALID_ICONS) {
      await expect(projectsSvc.create(tenantId, ownerId, { name: 'x', team_ids: [teamId], icon: bad })).rejects.toThrow(
        BadRequestException,
      );
      await expect(projectsSvc.update(tenantId, ownerId, p.id, { icon: bad })).rejects.toThrow(/invalid icon/);
    }
    // Non-strings never reach the column either.
    await expect(projectsSvc.update(tenantId, ownerId, p.id, { icon: 42 })).rejects.toThrow(/invalid icon/);
    await expect(projectsSvc.update(tenantId, ownerId, p.id, { icon: { lucide: 'rocket' } })).rejects.toThrow(/invalid icon/);
    expect((await rowOf(p.id)).icon).toBeNull(); // nothing leaked through
  });

  it('service create / update: bad colours → BadRequest', async () => {
    const p = await mkProject();
    for (const bad of INVALID_COLORS) {
      await expect(projectsSvc.create(tenantId, ownerId, { name: 'x', team_ids: [teamId], color: bad })).rejects.toThrow(
        /color must be #RRGGBB/,
      );
      await expect(projectsSvc.update(tenantId, ownerId, p.id, { color: bad })).rejects.toThrow(/color must be #RRGGBB/);
    }
    await expect(projectsSvc.update(tenantId, ownerId, p.id, { color: 0xdc2626 })).rejects.toThrow(/color must be #RRGGBB/);
    expect((await rowOf(p.id)).color).toBeNull();
  });

  it('the sync door (executor project.update / project.create) rejects them with E400 and leaves the row alone', async () => {
    const p = await mkProject({ icon: 'lucide:rocket', color: '#DC2626' });
    for (const bad of INVALID_ICONS) {
      const r = await syncUpdate(p.id, { icon: bad });
      expect(r.status).toBe('rejected');
      expect(r.errorCode).toMatch(/^E400:invalid icon/);
    }
    for (const bad of INVALID_COLORS) {
      const r = await syncUpdate(p.id, { color: bad });
      expect(r.status).toBe('rejected');
      expect(r.errorCode).toMatch(/^E400:color must be #RRGGBB/);
    }
    const row = await rowOf(p.id);
    expect(row.icon).toBe('lucide:rocket');
    expect(row.color).toBe('#DC2626');

    const created = await executor.execute(tenantId, ownerId, [
      {
        clientMutationId: crypto.randomUUID(),
        op: 'project.create' as const,
        id: crypto.randomUUID(),
        fields: { name: `Sync bad ${rid()}`, team_ids: [teamId], icon: 'lucide:Rocket' },
      },
    ]);
    expect(created.results[0]!.status).toBe('rejected');
    expect(created.results[0]!.errorCode).toMatch(/^E400:invalid icon/);
  });

  it('the REST door (CreateProjectDto / UpdateProjectDto under the global ValidationPipe) refuses them too', async () => {
    for (const bad of INVALID_ICONS) {
      await expect(pipe.transform({ name: 'x', icon: bad }, createMeta)).rejects.toThrow(BadRequestException);
      await expect(pipe.transform({ icon: bad }, updateMeta)).rejects.toThrow(BadRequestException);
    }
    for (const bad of INVALID_COLORS) {
      await expect(pipe.transform({ name: 'x', color: bad }, createMeta)).rejects.toThrow(BadRequestException);
      await expect(pipe.transform({ color: bad }, updateMeta)).rejects.toThrow(BadRequestException);
    }
    // Over-long strings fall to @MaxLength even when they would regex-match nothing anyway.
    await expect(pipe.transform({ icon: `lucide:${'a'.repeat(40)}` }, updateMeta)).rejects.toThrow(BadRequestException);
    // Non-strings on the nullable update fields.
    await expect(pipe.transform({ icon: 42 }, updateMeta)).rejects.toThrow(BadRequestException);
    await expect(pipe.transform({ color: 42 }, updateMeta)).rejects.toThrow(BadRequestException);
    await expect(pipe.transform({ icon: { lucide: 'rocket' } }, updateMeta)).rejects.toThrow(BadRequestException);
    // …and on create: the pipe's implicit conversion must not turn 42 / true
    // into an accepted '42' / 'true' text tile.
    await expect(pipe.transform({ name: 'x', icon: 42 }, createMeta)).rejects.toThrow(BadRequestException);
    await expect(pipe.transform({ name: 'x', icon: true }, createMeta)).rejects.toThrow(BadRequestException);
    await expect(pipe.transform({ name: 'x', color: 42 }, createMeta)).rejects.toThrow(BadRequestException);
    await expect(pipe.transform({ name: 'x', icon: { lucide: 'rocket' } }, createMeta)).rejects.toThrow(BadRequestException);
    // The messages name the field rule.
    await expect(pipe.transform({ color: 'red' }, updateMeta)).rejects.toMatchObject({
      response: { message: expect.arrayContaining(['color must be #RRGGBB']) },
    });
  });

  it('the REST door accepts the good shapes, including a legacy emoji', async () => {
    const created = (await pipe.transform({ name: 'Good', icon: 'lucide:rocket', color: '#DC2626' }, createMeta)) as CreateProjectDto;
    expect(created.icon).toBe('lucide:rocket');
    expect(created.color).toBe('#DC2626');
    const emoji = (await pipe.transform({ name: 'Old', icon: '🚀' }, createMeta)) as CreateProjectDto;
    expect(emoji.icon).toBe('🚀');
    const updated = (await pipe.transform({ icon: 'lucide:folder-kanban', color: '#2563eb' }, updateMeta)) as UpdateProjectDto;
    expect(updated.icon).toBe('lucide:folder-kanban');
    expect(updated.color).toBe('#2563eb');
    const bare = (await pipe.transform({ name: 'Bare' }, createMeta)) as CreateProjectDto;
    expect(bare.icon).toBeUndefined();
    expect(bare.color).toBeUndefined();
  });
});

describe('R5-5 — security audit (2026-10-06): the sync door never leaks another workspace\'s project', () => {
  let otherTenant: string;
  let otherOwner: string;

  beforeAll(async () => {
    const [t] = await dbAdmin
      .insert(tenants)
      .values({ name: `RP5 Other ${rid()}`, slug: `rp5-other-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
      .returning();
    otherTenant = t!.id;
    const [u] = await dbAdmin
      .insert(users)
      .values({ email: `rp5-other-${rid()}@t.test`, full_name: 'RP5 Other owner', status: 'active' })
      .returning();
    otherOwner = u!.id;
    trackedUsers.push(otherOwner);
    await dbAdmin.insert(memberships).values({ tenant_id: otherTenant, user_id: otherOwner, role: 'owner', status: 'active' });
    await teamsSvc.ensureWorkspace(otherTenant, otherOwner);
  });

  afterAll(async () => {
    await dbAdmin.delete(domainEvents).where(eq(domainEvents.tenant_id, otherTenant));
    await dbAdmin.delete(tenants).where(eq(tenants.id, otherTenant));
  });

  it('project.create re-using a project id from another workspace answers a generic E409 — no driver text, no existence detail — and the victim row is untouched', async () => {
    const victim = await mkProject({ icon: 'lucide:rocket', color: '#DC2626' });
    const before = await rowOf(victim.id);
    const res = await executor.execute(otherTenant, otherOwner, [
      { clientMutationId: crypto.randomUUID(), op: 'project.create' as const, id: victim.id, fields: { name: 'collide', icon: 'lucide:bug' } },
      { clientMutationId: crypto.randomUUID(), op: 'project.update' as const, id: victim.id, fields: { name: 'pwned', icon: 'lucide:bug' } },
    ]);
    expect(res.results[0]).toMatchObject({ status: 'rejected', errorCode: 'E409:Already exists' });
    expect(res.results[1]!.status).toBe('rejected');
    for (const r of res.results) {
      expect(r.errorCode).not.toMatch(/duplicate key|violates|constraint|pm_projects|invalid input syntax/);
    }
    expect(await rowOf(victim.id)).toEqual(before);
    const leaked = await dbAdmin.select({ id: pmProjects.id }).from(pmProjects).where(and(eq(pmProjects.tenant_id, otherTenant), eq(pmProjects.name, 'collide')));
    expect(leaked).toHaveLength(0);
  });
});

describe('R5-6 — security audit (2026-10-06): a project can only link a deal of its own workspace', () => {
  it('create with a deal id that is not a live deal of this workspace → 404 on both doors, nothing inserted', async () => {
    const strangerDeal = crypto.randomUUID();
    const name = `Deal link ${rid()}`;
    await expect(projectsSvc.create(tenantId, ownerId, { name, team_ids: [teamId], deal_id: strangerDeal })).rejects.toThrow('Deal not found');
    const res = await executor.execute(tenantId, ownerId, [
      { clientMutationId: crypto.randomUUID(), op: 'project.create' as const, id: crypto.randomUUID(), fields: { name, team_ids: [teamId], deal_id: strangerDeal } },
    ]);
    expect(res.results[0]).toMatchObject({ status: 'rejected', errorCode: 'E404:Deal not found' });
    expect(await dbAdmin.select({ id: pmProjects.id }).from(pmProjects).where(and(eq(pmProjects.tenant_id, tenantId), eq(pmProjects.name, name)))).toHaveLength(0);
  });
});
