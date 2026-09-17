import 'dotenv/config';
import * as crypto from 'crypto';
import sharp from 'sharp';
import JSZip from 'jszip';
import { and, eq, inArray } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  tenants,
  users,
  memberships,
  pmTeams,
  pmTeamMemberships,
  pmProjectMembers,
  pmIssueComments,
  recordFiles,
  domainEvents,
} from '@flicks/db/schema';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { DomainEventsService } from '../core/events/domain-events.service';
import { PmTeamsService } from '../modules/pm/teams.service';
import { PmIssuesService } from '../modules/pm/issues.service';
import { PmProjectsService } from '../modules/pm/projects.service';
import { PmVisibilityService } from '../modules/pm/sync/visibility.service';
import { PmFilesService } from '../modules/pm/files.service';
import { mapUploadError } from '../modules/pm/files.controller';
import { cleanMarkdown, extractFileIds } from '../modules/pm/markdown';
import { attachmentDisposition } from '../core/storage/r2.service';

/**
 * Round L item 6 — PM attachments + inline media. Real Postgres; R2 stubbed
 * with spies (no storage in CI). Pins: magic-byte allow/deny, the three
 * 413s (size / count / tenant quota), bindDraftsTx ownership + tenant
 * isolation, guest scoping (own-project issue + comment ok, other project
 * 404), resolveForRead for non-members, cleanMarkdown, soft delete by
 * uploader/admin only, and the 24 h orphan-draft prune.
 */

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const emitter = new EventEmitter2();
const domainEventsSvc = new DomainEventsService(dbAdmin as never, emitter);
const visibility = new PmVisibilityService(dbSvc);
const mediaStub = { servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l) } as never;
const notificationsStub = { createInAppNotification: async () => undefined, sendEmail: async () => true } as never;
const teamsSvc = new PmTeamsService(dbSvc, audit, domainEventsSvc, visibility, mediaStub);
const issuesSvc = new PmIssuesService(dbSvc, audit, domainEventsSvc, notificationsStub, visibility);
const projectsSvc = new PmProjectsService(dbSvc, audit, domainEventsSvc, visibility, mediaStub);

const r2 = {
  configured: true,
  isConfigured: jest.fn((): boolean => r2.configured),
  putObject: jest.fn(async (_key: string, _body: Buffer, _mime: string, _cc?: string) => undefined),
  signedGetUrl: jest.fn(
    async (key: string, ttl?: number, opts?: { download?: { fileName: string } }) =>
      `https://signed.test/${key}?ttl=${ttl}${opts?.download ? '&dl=1' : ''}`,
  ),
  deleteObjects: jest.fn(async (_keys: string[]) => undefined),
  deleteObject: jest.fn(async (_key: string) => undefined),
};
const files = new PmFilesService(dbSvc, dbAdmin as never, visibility, r2 as never, audit);

const png = async (w = 300, h = 200) =>
  sharp({ create: { width: w, height: h, channels: 3, background: '#3E7BFA' } }).png().toBuffer();
const csv = (rows = 3) => Buffer.from(['name,qty', ...Array.from({ length: rows }, (_, i) => `row${i},${i}`)].join('\n'));
/** Minimal OOXML container (file-type reads the `word/` entry → docx). */
const ooxml = async () => {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
  z.file('_rels/.rels', '<Relationships/>');
  z.file('word/document.xml', '<w:document/>');
  return z.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
};
const plainZip = async () => {
  const z = new JSZip();
  z.file('readme.txt', 'hello');
  return z.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
};
const file = (buffer: Buffer, originalname: string) => ({ buffer, originalname, size: buffer.length });
const uuid = () => crypto.randomUUID();

let tenantId: string;
let tenantB: string;
let ownerId: string;
let adminId: string;
let memberId: string; // plain employee — not in the private team
let guestId: string; // project-scoped seat on projectA only
let ownerBId: string;
let teamId: string;
let privateTeamId: string;
let projectA: string;
let projectB: string;
let issueOpen: string; // default team, no project
let issueP1: string; // in projectA (guest's)
let issueP2: string; // in projectB (not the guest's)
let issueSec: string; // private team

beforeAll(async () => {
  const mkTenant = async (name: string) => {
    const [t] = await dbAdmin
      .insert(tenants)
      .values({ name: `${name} ${rid()}`, slug: `pmf-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
      .returning();
    return t!.id;
  };
  tenantId = await mkTenant('Attach Co');
  tenantB = await mkTenant('Other Co');
  const mkUser = async (tenant: string, role: 'owner' | 'admin' | 'employee' | 'guest') => {
    const [u] = await dbAdmin
      .insert(users)
      .values({ email: `pmf-${role}-${rid()}@t.test`, full_name: `PM ${role}`, status: 'active' })
      .returning();
    await dbAdmin.insert(memberships).values({ tenant_id: tenant, user_id: u!.id, role, status: 'active' });
    return u!.id;
  };
  ownerId = await mkUser(tenantId, 'owner');
  adminId = await mkUser(tenantId, 'admin');
  memberId = await mkUser(tenantId, 'employee');
  guestId = await mkUser(tenantId, 'guest');
  ownerBId = await mkUser(tenantB, 'owner');

  await teamsSvc.ensureWorkspace(tenantId, ownerId);
  const [team] = await dbAdmin.select().from(pmTeams).where(eq(pmTeams.tenant_id, tenantId));
  teamId = team!.id;
  const priv = await teamsSvc.create(tenantId, ownerId, { key: 'SEC', name: 'Secret', is_private: true });
  privateTeamId = priv.data.id;
  await dbAdmin
    .delete(pmTeamMemberships)
    .where(and(eq(pmTeamMemberships.team_id, privateTeamId), eq(pmTeamMemberships.user_id, memberId)));
  await dbAdmin
    .delete(pmTeamMemberships)
    .where(and(eq(pmTeamMemberships.team_id, privateTeamId), eq(pmTeamMemberships.user_id, guestId)));

  projectA = (await projectsSvc.create(tenantId, ownerId, { name: 'Guest project', team_ids: [teamId] })).data.id;
  projectB = (await projectsSvc.create(tenantId, ownerId, { name: 'Other project', team_ids: [teamId] })).data.id;
  await dbAdmin.insert(pmProjectMembers).values({ tenant_id: tenantId, project_id: projectA, user_id: guestId });

  issueOpen = (await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: 'Open issue' })).data.id;
  issueP1 = (await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: 'In guest project', project_id: projectA })).data.id;
  issueP2 = (await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: 'In other project', project_id: projectB })).data.id;
  issueSec = (await issuesSvc.create(tenantId, ownerId, { team_id: privateTeamId, title: 'Private team issue' })).data.id;
  await teamsSvc.ensureWorkspace(tenantB, ownerBId);
});

afterAll(async () => {
  delete process.env['PM_ATTACHMENTS_TENANT_QUOTA_MB'];
  for (const t of [tenantId, tenantB]) {
    await dbAdmin.delete(domainEvents).where(eq(domainEvents.tenant_id, t));
    await dbAdmin.delete(tenants).where(eq(tenants.id, t));
  }
  for (const u of [ownerId, adminId, memberId, guestId, ownerBId]) {
    await dbAdmin.delete(users).where(eq(users.id, u));
  }
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

beforeEach(() => {
  r2.configured = true;
  r2.putObject.mockClear();
  r2.signedGetUrl.mockClear();
  r2.deleteObjects.mockClear();
  r2.deleteObject.mockClear();
});

describe('magic-byte allow/deny', () => {
  it('accepts a PNG: re-encoded, dimensions + thumb + sha256 stored, two objects written under the tenant prefix', async () => {
    const res = await files.upload(tenantId, ownerId, {
      objectType: 'issue',
      objectId: issueOpen,
      kind: 'inline',
      files: [file(await png(), 'Screen Shot 2026-09-17 at 10.00.png')],
    });
    expect(res.data).toHaveLength(1);
    const f = res.data[0]!;
    expect(f.mime_type).toBe('image/png');
    expect(f.kind).toBe('inline');
    expect(f.width).toBe(300);
    expect(f.height).toBe(200);
    expect(f.url).toMatch(/^https:\/\/signed\.test\//);
    expect(f.thumb_url).toContain('/thumb.webp');
    expect(f.file_name).toBe('Screen Shot 2026-09-17 at 10.00.png');
    expect(r2.putObject).toHaveBeenCalledTimes(2);
    const keys = r2.putObject.mock.calls.map((c) => c[0]);
    expect(keys.every((k) => k.startsWith(`tenants/${tenantId}/pm-files/${f.id}/`))).toBe(true);
    expect(keys.some((k) => k.endsWith('/Screen_Shot_2026-09-17_at_10.00.png'))).toBe(true);
    expect(r2.putObject.mock.calls[0]![2]).toBe('image/png');
    const [row] = await dbAdmin.select().from(recordFiles).where(eq(recordFiles.id, f.id));
    expect(row!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.thumb_key).toBe(`tenants/${tenantId}/pm-files/${f.id}/thumb.webp`);
    expect(Number(row!.size_bytes)).toBe(r2.putObject.mock.calls[0]![1].length);
  });

  it('rejects SVG whatever the extension claims', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    await expect(
      files.upload(tenantId, ownerId, { objectType: 'issue', objectId: issueOpen, kind: 'attachment', files: [file(svg, 'logo.svg')] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      files.upload(tenantId, ownerId, { objectType: 'issue', objectId: issueOpen, kind: 'attachment', files: [file(svg, 'logo.png')] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      files.upload(tenantId, ownerId, { objectType: 'issue', objectId: issueOpen, kind: 'attachment', files: [file(svg, 'logo.txt')] }),
    ).rejects.toThrow(/"logo\.txt" isn.t a supported type/); // the rejection names the file
    expect(r2.putObject).not.toHaveBeenCalled();
  });

  it('rejects HTML, JS and executables (also when renamed to an allowed extension)', async () => {
    const html = Buffer.from('<!doctype html><html><body>hi</body></html>');
    const js = Buffer.from('window.location = "https://evil.test"');
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(512, 0)]);
    for (const [buf, name] of [
      [html, 'page.html'],
      [html, 'page.txt'],
      [js, 'x.js'],
      [js, 'x.mjs'],
      [exe, 'setup.exe'],
      [exe, 'setup.pdf'],
      [exe, 'setup.doc'],
    ] as Array<[Buffer, string]>) {
      await expect(
        files.upload(tenantId, ownerId, { objectType: 'issue', objectId: issueOpen, kind: 'attachment', files: [file(buf, name)] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(r2.putObject).not.toHaveBeenCalled();
  });

  it('accepts UTF-8 CSV / PDF; rejects a CSV that starts with "<" and a non-image inline', async () => {
    const ok = await files.upload(tenantId, ownerId, {
      objectType: 'issue',
      objectId: issueOpen,
      kind: 'attachment',
      files: [file(csv(), 'data.csv'), file(Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 32)]), 'spec.pdf')],
    });
    expect(ok.data.map((f) => f.mime_type)).toEqual(['text/csv', 'application/pdf']);
    expect(ok.data[0]!.thumb_url).toBeNull();
    expect(ok.data[0]!.width).toBeNull();
    await expect(
      files.upload(tenantId, ownerId, {
        objectType: 'issue',
        objectId: issueOpen,
        kind: 'attachment',
        files: [file(Buffer.from('<?xml version="1.0"?><rows/>'), 'data.csv')],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      files.upload(tenantId, ownerId, { objectType: 'issue', objectId: issueOpen, kind: 'inline', files: [file(csv(), 'data.csv')] }),
    ).rejects.toThrow(/Only images/);
  });

  it('storage unconfigured ⇒ 503 before any validation work', async () => {
    r2.configured = false;
    await expect(
      files.upload(tenantId, ownerId, { objectType: 'issue', objectId: issueOpen, kind: 'attachment', files: [file(csv(), 'a.csv')] }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('limits → 413', () => {
  it('a file over 25 MB', async () => {
    const big = Buffer.alloc(26 * 1024 * 1024, 1);
    await expect(
      files.upload(tenantId, ownerId, { objectType: 'issue', objectId: issueOpen, kind: 'attachment', files: [file(big, 'big.bin')] }),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('more than 10 files in one request', async () => {
    const many = Array.from({ length: 11 }, (_, i) => file(csv(), `f${i}.csv`));
    await expect(
      files.upload(tenantId, ownerId, { objectType: 'issue', objectId: issueOpen, kind: 'attachment', files: many }),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('tenant quota (PM_ATTACHMENTS_TENANT_QUOTA_MB) — nothing is written past it', async () => {
    process.env['PM_ATTACHMENTS_TENANT_QUOTA_MB'] = '0.0001'; // ≈105 bytes
    try {
      await expect(
        files.upload(tenantId, ownerId, { objectType: 'issue', objectId: issueOpen, kind: 'attachment', files: [file(csv(20), 'q.csv')] }),
      ).rejects.toThrow(/storage is full/);
      expect(r2.putObject).not.toHaveBeenCalled();
    } finally {
      delete process.env['PM_ATTACHMENTS_TENANT_QUOTA_MB'];
    }
    // Back to the default (2 GB) it goes through.
    const ok = await files.upload(tenantId, ownerId, { objectType: 'issue', objectId: issueOpen, kind: 'attachment', files: [file(csv(), 'q.csv')] });
    expect(ok.data).toHaveLength(1);
  });
});

describe('bindDraftsTx', () => {
  it('binds only this user’s live drafts in this tenant; another user’s draft or a cross-tenant id fails the whole call', async () => {
    const draftKey = uuid();
    const mine = (await files.upload(tenantId, ownerId, { objectType: 'draft', objectId: draftKey, kind: 'attachment', files: [file(csv(), 'mine.csv')] })).data[0]!;
    const theirs = (await files.upload(tenantB, ownerBId, { objectType: 'draft', objectId: uuid(), kind: 'attachment', files: [file(csv(), 'theirs.csv')] })).data[0]!;

    // Another user in the same tenant cannot pull my draft into their issue.
    await expect(
      dbSvc.withTenant(tenantId, (tx) => files.bindDraftsTx(tx, tenantId, memberId, { objectType: 'issue', objectId: issueOpen }, [mine.id]), memberId),
    ).rejects.toBeInstanceOf(BadRequestException);
    // A cross-tenant id poisons the call — nothing binds.
    await expect(
      dbSvc.withTenant(tenantId, (tx) => files.bindDraftsTx(tx, tenantId, ownerId, { objectType: 'issue', objectId: issueOpen }, [mine.id, theirs.id]), ownerId),
    ).rejects.toBeInstanceOf(BadRequestException);
    let [row] = await dbAdmin.select().from(recordFiles).where(eq(recordFiles.id, mine.id));
    expect(row!.object_type).toBe('draft');

    // The owner binds their own draft.
    const bound = await dbSvc.withTenant(
      tenantId,
      (tx) => files.bindDraftsTx(tx, tenantId, ownerId, { objectType: 'issue', objectId: issueOpen }, [mine.id, mine.id.toUpperCase()]),
      ownerId,
    );
    expect(bound).toEqual([mine.id]);
    [row] = await dbAdmin.select().from(recordFiles).where(eq(recordFiles.id, mine.id));
    expect(row!.object_type).toBe('issue');
    expect(row!.object_id).toBe(issueOpen);
    // Once bound it is no longer a draft — rebinding is refused.
    await expect(
      dbSvc.withTenant(tenantId, (tx) => files.bindDraftsTx(tx, tenantId, ownerId, { objectType: 'issue', objectId: issueP1 }, [mine.id]), ownerId),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Empty / non-uuid input.
    expect(await dbSvc.withTenant(tenantId, (tx) => files.bindDraftsTx(tx, tenantId, ownerId, { objectType: 'issue', objectId: issueOpen }, []), ownerId)).toEqual([]);
    await expect(
      dbSvc.withTenant(tenantId, (tx) => files.bindDraftsTx(tx, tenantId, ownerId, { objectType: 'issue', objectId: issueOpen }, ['nope']), ownerId),
    ).rejects.toBeInstanceOf(BadRequestException);
    // The other tenant's draft is untouched.
    const [theirRow] = await dbAdmin.select().from(recordFiles).where(eq(recordFiles.id, theirs.id));
    expect(theirRow!.object_type).toBe('draft');
    expect(theirRow!.tenant_id).toBe(tenantB);
  });
});

describe('guest scoping', () => {
  it('a guest attaches to an issue and to their own comment inside their project; another project is 404', async () => {
    const onIssue = await files.upload(tenantId, guestId, { objectType: 'issue', objectId: issueP1, kind: 'attachment', files: [file(csv(), 'guest.csv')] });
    expect(onIssue.data[0]!.uploaded_by).toBe(guestId);

    const comment = (await issuesSvc.createComment(tenantId, guestId, issueP1, { body: 'from the guest' })).data;
    const onComment = await files.upload(tenantId, guestId, { objectType: 'comment', objectId: comment.id, kind: 'attachment', files: [file(await png(), 'shot.png')] });
    expect(onComment.data[0]!.object_type).toBe('comment');

    // Not the author of that comment ⇒ 403 (the issue itself is visible).
    await expect(
      files.upload(tenantId, ownerId, { objectType: 'comment', objectId: comment.id, kind: 'attachment', files: [file(csv(), 'x.csv')] }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // Outside the guest's projects: existence is never revealed.
    await expect(
      files.upload(tenantId, guestId, { objectType: 'issue', objectId: issueP2, kind: 'attachment', files: [file(csv(), 'x.csv')] }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(files.listForIssue(tenantId, guestId, issueP2)).rejects.toBeInstanceOf(NotFoundException);

    // listForIssue returns the issue's own files AND its comments' files.
    const list = await files.listForIssue(tenantId, guestId, issueP1);
    const ids = list.data.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining([onIssue.data[0]!.id, onComment.data[0]!.id]));
    expect(list.data.find((f) => f.id === onComment.data[0]!.id)!.thumb_url).toContain('thumb.webp');
  });

  it('resolveForRead: guest reads their project’s file, not another project’s; drafts are uploader-only', async () => {
    const other = (await files.upload(tenantId, ownerId, { objectType: 'issue', objectId: issueP2, kind: 'attachment', files: [file(csv(), 'p2.csv')] })).data[0]!;
    const own = (await files.upload(tenantId, ownerId, { objectType: 'issue', objectId: issueP1, kind: 'attachment', files: [file(csv(), 'p1.csv')] })).data[0]!;
    expect((await files.resolveForRead(tenantId, guestId, own.id)).id).toBe(own.id);
    await expect(files.resolveForRead(tenantId, guestId, other.id)).rejects.toBeInstanceOf(NotFoundException);

    const draft = (await files.upload(tenantId, ownerId, { objectType: 'draft', objectId: uuid(), kind: 'attachment', files: [file(csv(), 'd.csv')] })).data[0]!;
    expect((await files.resolveForRead(tenantId, ownerId, draft.id)).id).toBe(draft.id);
    await expect(files.resolveForRead(tenantId, memberId, draft.id)).rejects.toBeInstanceOf(NotFoundException);
    // Cross-tenant id ⇒ 404 (RLS + explicit predicate).
    await expect(files.resolveForRead(tenantB, ownerBId, own.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(files.resolveForRead(tenantId, ownerId, 'not-a-uuid')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('resolveForRead denies non-members of a private team; signed redirect URLs', () => {
  it('private-team file: member of the team ok, outsider 404; ?dl adds the download disposition on a 15-minute URL', async () => {
    const f = (await files.upload(tenantId, ownerId, { objectType: 'issue', objectId: issueSec, kind: 'attachment', files: [file(csv(), 'secret.csv')] })).data[0]!;
    expect((await files.resolveForRead(tenantId, ownerId, f.id)).id).toBe(f.id);
    await expect(files.resolveForRead(tenantId, memberId, f.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(files.resolveForRead(tenantId, guestId, f.id)).rejects.toBeInstanceOf(NotFoundException);

    r2.signedGetUrl.mockClear();
    const url = await files.signedUrlForRead(tenantId, ownerId, f.id, { download: true });
    expect(url).toContain('&dl=1');
    expect(r2.signedGetUrl).toHaveBeenCalledWith(expect.stringContaining(`pm-files/${f.id}/`), 900, { download: { fileName: 'secret.csv' } });
    const inline = await files.signedUrlForRead(tenantId, ownerId, f.id);
    expect(inline).not.toContain('dl=1');
    // Embedded URLs are signed for an hour.
    expect(f.url).toContain('ttl=3600');
  });

  it('attachmentDisposition: ASCII fallback + RFC 5987 form, header-safe', () => {
    const d = attachmentDisposition('résumé "final"\r\nX-Evil: 1.pdf');
    expect(d).not.toMatch(/[\r\n]/);
    // quote → _, CR → _, LF → _ : three underscores between "final" and "X-Evil".
    expect(d).toContain('attachment; filename="r_sum_ _final___X-Evil: 1.pdf"');
    expect(d).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9%20_final___X-Evil%3A%201.pdf");
    expect(attachmentDisposition('')).toContain('filename="download"');
  });
});

describe('cleanMarkdown', () => {
  const id = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  it('strips <img onerror> and script tags, keeps text', () => {
    expect(cleanMarkdown('hello <img src=x onerror=alert(1)> world', { maxLen: 100 })).toBe('hello  world');
    expect(cleanMarkdown('<script>alert(1)</script>after', { maxLen: 100 })).toBe('after');
    expect(cleanMarkdown('<a href="javascript:alert(1)">x</a>', { maxLen: 100 })).toBe('x');
    // Double-encoded tags cannot survive the decode.
    expect(cleanMarkdown('&lt;script&gt;alert(1)&lt;/script&gt;ok', { maxLen: 100 })).not.toContain('<script');
  });
  it('unwraps javascript:/data:/http: link targets, keeps https: and flicks-file:// images', () => {
    expect(cleanMarkdown('[click](javascript:alert(1))', { maxLen: 100 })).toBe('click');
    // Angle-bracket destinations may contain tabs/spaces (CommonMark) — the
    // control chars a browser would strip are removed before judging.
    expect(cleanMarkdown('[click](<JAVA\tSCRIPT:alert(1)>)', { maxLen: 100 })).toBe('click');
    // A bare destination with whitespace is not a link in CommonMark: inert text stays.
    expect(cleanMarkdown('[click](  JAVA\tSCRIPT:alert(1) )', { maxLen: 100 })).toBe('[click](  JAVA\tSCRIPT:alert(1) )');
    expect(cleanMarkdown('[a](data:text/html;base64,PHNjcmlwdD4=)', { maxLen: 100 })).toBe('a');
    expect(cleanMarkdown('![x](http://evil.test/a.png)', { maxLen: 100 })).toBe('x');
    expect(cleanMarkdown('[ok](https://example.com/a?b=c "t")', { maxLen: 100 })).toBe('[ok](https://example.com/a?b=c "t")');
    expect(cleanMarkdown(`before\n\n![shot](flicks-file://${id.toUpperCase()})\n\nafter`, { maxLen: 100 })).toBe(
      `before\n\n![shot](flicks-file://${id})\n\nafter`,
    );
    expect(cleanMarkdown('![shot](flicks-file://not-a-uuid)', { maxLen: 100 })).toBe('shot');
  });
  it('leaves code spans/blocks and markdown syntax alone; enforces maxLen; null ⇒ ""', () => {
    expect(cleanMarkdown('use `<Button>` here', { maxLen: 100 })).toBe('use `<Button>` here');
    expect(cleanMarkdown('```html\n<b>bold</b>\n```', { maxLen: 100 })).toBe('```html\n<b>bold</b>\n```');
    expect(cleanMarkdown('> quote\n\n- a < b & c > d', { maxLen: 100 })).toBe('> quote\n\n- a < b & c > d');
    expect(cleanMarkdown(null, { maxLen: 10 })).toBe('');
    expect(() => cleanMarkdown('x'.repeat(11), { maxLen: 10, label: 'Comment' })).toThrow(BadRequestException);
    expect(extractFileIds(`![a](flicks-file://${id}) ![b](flicks-file://${id.toUpperCase()})`)).toEqual([id]);
  });
});

describe('soft delete', () => {
  it('uploader or Owner/Admin only; objects removed after commit; the row stops resolving', async () => {
    const f = (await files.upload(tenantId, ownerId, { objectType: 'issue', objectId: issueOpen, kind: 'attachment', files: [file(await png(), 'del.png')] })).data[0]!;
    await expect(files.softDelete(tenantId, memberId, f.id)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(files.softDelete(tenantId, guestId, f.id)).rejects.toBeInstanceOf(NotFoundException); // not visible at all
    r2.deleteObjects.mockClear();
    const res = await files.softDelete(tenantId, adminId, f.id);
    expect(res.data).toEqual({ id: f.id, deleted: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(r2.deleteObjects).toHaveBeenCalledWith([expect.stringContaining(`/${f.id}/`), `tenants/${tenantId}/pm-files/${f.id}/thumb.webp`]);
    await expect(files.resolveForRead(tenantId, ownerId, f.id)).rejects.toBeInstanceOf(NotFoundException);
    const [row] = await dbAdmin.select().from(recordFiles).where(eq(recordFiles.id, f.id));
    expect(row!.deleted_at).not.toBeNull();

    // The uploader removes their own; a guest removes their own on their project.
    const mine = (await files.upload(tenantId, memberId, { objectType: 'issue', objectId: issueOpen, kind: 'attachment', files: [file(csv(), 'mine.csv')] })).data[0]!;
    expect((await files.softDelete(tenantId, memberId, mine.id)).data.deleted).toBe(true);
    const g = (await files.upload(tenantId, guestId, { objectType: 'issue', objectId: issueP1, kind: 'attachment', files: [file(csv(), 'g.csv')] })).data[0]!;
    await expect(files.softDelete(tenantId, memberId, g.id)).rejects.toBeInstanceOf(ForbiddenException);
    expect((await files.softDelete(tenantId, guestId, g.id)).data.deleted).toBe(true);
    // Deleted files fall out of the issue listing.
    const list = await files.listForIssue(tenantId, ownerId, issueOpen);
    expect(list.data.some((x) => x.id === f.id || x.id === mine.id)).toBe(false);
  });
});

describe('orphan-draft prune', () => {
  it('removes only drafts older than 24 h (rows + objects); fresh drafts and bound files survive', async () => {
    const stale = (await files.upload(tenantId, ownerId, { objectType: 'draft', objectId: uuid(), kind: 'attachment', files: [file(csv(), 'stale.csv')] })).data[0]!;
    const fresh = (await files.upload(tenantId, ownerId, { objectType: 'draft', objectId: uuid(), kind: 'attachment', files: [file(csv(), 'fresh.csv')] })).data[0]!;
    const bound = (await files.upload(tenantId, ownerId, { objectType: 'draft', objectId: uuid(), kind: 'attachment', files: [file(csv(), 'bound.csv')] })).data[0]!;
    await dbSvc.withTenant(tenantId, (tx) => files.bindDraftsTx(tx, tenantId, ownerId, { objectType: 'issue', objectId: issueOpen }, [bound.id]), ownerId);
    const old = new Date(Date.now() - 25 * 3_600_000);
    await dbAdmin.update(recordFiles).set({ created_at: old }).where(eq(recordFiles.id, stale.id));
    await dbAdmin.update(recordFiles).set({ created_at: old }).where(eq(recordFiles.id, bound.id));

    r2.deleteObject.mockClear();
    const n = await files.pruneOrphanDrafts(new Date());
    expect(n).toBeGreaterThanOrEqual(1);
    const rows = await dbAdmin.select({ id: recordFiles.id }).from(recordFiles).where(eq(recordFiles.tenant_id, tenantId));
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(stale.id);
    expect(ids).toContain(fresh.id);
    expect(ids).toContain(bound.id);
    const deletedKeys = r2.deleteObject.mock.calls.map((c) => c[0]);
    expect(deletedKeys.some((k) => k.includes(`/${stale.id}/`))).toBe(true);
    expect(deletedKeys.some((k) => k.includes(`/${fresh.id}/`) || k.includes(`/${bound.id}/`))).toBe(false);
    // Re-run is a no-op for this tenant.
    r2.deleteObject.mockClear();
    await files.pruneOrphanDrafts(new Date());
    const again = r2.deleteObject.mock.calls.map((c) => c[0]);
    expect(again.some((k) => k.includes(`/${fresh.id}/`))).toBe(false);
  });

  it('claim-first: a bind that landed before the prune keeps its object; one that races after the claim is refused; a failed object delete keeps the row for the next run', async () => {
    const early = (await files.upload(tenantId, ownerId, { objectType: 'draft', objectId: uuid(), kind: 'attachment', files: [file(csv(), 'early.csv')] })).data[0]!;
    const late = (await files.upload(tenantId, ownerId, { objectType: 'draft', objectId: uuid(), kind: 'attachment', files: [file(csv(), 'late.csv')] })).data[0]!;
    const failing = (await files.upload(tenantId, ownerId, { objectType: 'draft', objectId: uuid(), kind: 'attachment', files: [file(csv(), 'failing.csv')] })).data[0]!;
    const old = new Date(Date.now() - 25 * 3_600_000);
    await dbAdmin.update(recordFiles).set({ created_at: old }).where(inArray(recordFiles.id, [early.id, late.id, failing.id]));
    // Bound before the prune runs (the guard's predicate excludes it).
    await dbSvc.withTenant(tenantId, (tx) => files.bindDraftsTx(tx, tenantId, ownerId, { objectType: 'issue', objectId: issueOpen }, [early.id]), ownerId);

    let lateBind: Promise<string[]> | null = null;
    r2.deleteObject.mockImplementation(async (key: string) => {
      // A bind arriving after the claim (during the object delete) — refused.
      if (key.includes(`/${late.id}/`)) {
        lateBind = dbSvc.withTenant(tenantId, (tx) => files.bindDraftsTx(tx, tenantId, ownerId, { objectType: 'issue', objectId: issueOpen }, [late.id]), ownerId);
        await lateBind.catch(() => undefined);
      }
      if (key.includes(`/${failing.id}/`)) throw new Error('R2 down');
    });
    try {
      await files.pruneOrphanDrafts(new Date());
    } finally {
      r2.deleteObject.mockImplementation(async () => undefined);
    }
    await expect(lateBind).rejects.toBeInstanceOf(BadRequestException);
    const rows = await dbAdmin
      .select({ id: recordFiles.id, object_type: recordFiles.object_type, deleted_at: recordFiles.deleted_at })
      .from(recordFiles)
      .where(inArray(recordFiles.id, [early.id, late.id, failing.id]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(early.id)?.object_type).toBe('issue'); // survived, object untouched
    expect(r2.deleteObject.mock.calls.some((c) => c[0].includes(`/${early.id}/`))).toBe(false);
    expect(byId.has(late.id)).toBe(false); // claimed + purged
    expect(byId.get(failing.id)?.object_type).toBe('draft'); // claimed, object delete failed → kept…
    expect(byId.get(failing.id)?.deleted_at).not.toBeNull();
    await expect(files.resolveForRead(tenantId, ownerId, failing.id)).rejects.toBeInstanceOf(NotFoundException); // …and invisible
    // Next run (storage back) retries and purges it.
    r2.deleteObject.mockClear();
    await files.pruneOrphanDrafts(new Date());
    expect(r2.deleteObject.mock.calls.some((c) => c[0].includes(`/${failing.id}/`))).toBe(true);
    expect((await dbAdmin.select({ id: recordFiles.id }).from(recordFiles).where(eq(recordFiles.id, failing.id))).length).toBe(0);
  });
});

describe('review-round pins', () => {
  it('cross-tenant issue id → 404; comment upload on an invisible issue → 404; another user’s draft: delete → 404', async () => {
    await expect(
      files.upload(tenantB, ownerBId, { objectType: 'issue', objectId: issueOpen, kind: 'attachment', files: [file(csv(), 'x.csv')] }),
    ).rejects.toBeInstanceOf(NotFoundException);
    const c = (await issuesSvc.createComment(tenantId, ownerId, issueP2, { body: 'owner on P2' })).data;
    await expect(
      files.upload(tenantId, guestId, { objectType: 'comment', objectId: c.id, kind: 'attachment', files: [file(csv(), 'x.csv')] }),
    ).rejects.toBeInstanceOf(NotFoundException);
    const draft = (await files.upload(tenantId, ownerId, { objectType: 'draft', objectId: uuid(), kind: 'attachment', files: [file(csv(), 'd.csv')] })).data[0]!;
    await expect(files.softDelete(tenantId, memberId, draft.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(files.softDelete(tenantId, adminId, draft.id)).rejects.toBeInstanceOf(NotFoundException);
    expect((await files.softDelete(tenantId, ownerId, draft.id)).data.deleted).toBe(true);
  });

  it('a soft-deleted comment’s files leave the issue listing; softDeleteForObjectTx is the parent-delete hook', async () => {
    const c = (await issuesSvc.createComment(tenantId, ownerId, issueOpen, { body: 'doomed' })).data;
    const f = (await files.upload(tenantId, ownerId, { objectType: 'comment', objectId: c.id, kind: 'attachment', files: [file(await png(), 'c.png')] })).data[0]!;
    expect((await files.listForIssue(tenantId, ownerId, issueOpen)).data.some((x) => x.id === f.id)).toBe(true);
    await dbAdmin.update(pmIssueComments).set({ deleted_at: new Date() }).where(eq(pmIssueComments.id, c.id));
    expect((await files.listForIssue(tenantId, ownerId, issueOpen)).data.some((x) => x.id === f.id)).toBe(false);
    await expect(files.resolveForRead(tenantId, ownerId, f.id)).rejects.toBeInstanceOf(NotFoundException);
    const keys = await dbSvc.withTenant(
      tenantId,
      (tx) => files.softDeleteForObjectTx(tx, tenantId, { objectType: 'comment', objectId: c.id }),
      ownerId,
    );
    expect(keys).toEqual([expect.stringContaining(`/${f.id}/`), `tenants/${tenantId}/pm-files/${f.id}/thumb.webp`]);
    const [row] = await dbAdmin.select().from(recordFiles).where(eq(recordFiles.id, f.id));
    expect(row!.deleted_at).not.toBeNull();
    files.deleteObjectsAfterCommit(keys);
    await new Promise((r) => setTimeout(r, 10));
    expect(r2.deleteObjects).toHaveBeenCalledWith(keys);
  });

  it('extension gate on containers: .docm and a ZIP renamed .html are rejected; .docx and .zip pass', async () => {
    const docx = await ooxml();
    const zip = await plainZip();
    for (const [buf, name] of [
      [docx, 'macros.docm'],
      [docx, 'macros.zip'],
      [zip, 'page.html'],
      [zip, 'app.jar'],
      [zip, 'fake.xlsx'],
    ] as Array<[Buffer, string]>) {
      await expect(
        files.upload(tenantId, ownerId, { objectType: 'issue', objectId: issueOpen, kind: 'attachment', files: [file(buf, name)] }),
      ).rejects.toThrow(new RegExp(name.replace('.', '\\.')));
    }
    expect(r2.putObject).not.toHaveBeenCalled();
    const ok = await files.upload(tenantId, ownerId, {
      objectType: 'issue',
      objectId: issueOpen,
      kind: 'attachment',
      files: [file(docx, 'brief.docx'), file(zip, 'bundle.zip')],
    });
    expect(ok.data.map((f) => f.mime_type)).toEqual([
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/zip',
    ]);
  });

  it('a batch with one bad file fails whole before any object is written; a failed insert after the put cleans the objects up', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    await expect(
      files.upload(tenantId, ownerId, { objectType: 'issue', objectId: issueOpen, kind: 'attachment', files: [file(await png(), 'ok.png'), file(svg, 'bad.svg')] }),
    ).rejects.toThrow(/bad\.svg/);
    expect(r2.putObject).not.toHaveBeenCalled();

    const original = dbSvc.withTenant.bind(dbSvc);
    let calls = 0;
    const spy = jest.spyOn(dbSvc, 'withTenant').mockImplementation(((t: string, cb: (tx: never) => Promise<unknown>, u?: string) => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error('insert boom'));
      return original(t, cb as never, u);
    }) as never);
    try {
      await expect(
        files.upload(tenantId, ownerId, { objectType: 'issue', objectId: issueOpen, kind: 'attachment', files: [file(await png(), 'lost.png')] }),
      ).rejects.toThrow('insert boom');
    } finally {
      spy.mockRestore();
    }
    expect(r2.putObject).toHaveBeenCalledTimes(2);
    await new Promise((r) => setTimeout(r, 10));
    const putKeys = r2.putObject.mock.calls.map((c) => c[0]);
    expect(r2.deleteObjects).toHaveBeenCalledWith(putKeys);
  });

  it('multer limit errors map to readable 413s; anything else passes through', () => {
    expect(mapUploadError(new PayloadTooLargeException('File too large'))).toBeInstanceOf(PayloadTooLargeException);
    expect(String((mapUploadError(new PayloadTooLargeException('File too large')) as Error).message)).toMatch(/25 MB/);
    expect(mapUploadError(new BadRequestException('Unexpected field - files'))).toBeInstanceOf(PayloadTooLargeException);
    expect(mapUploadError(new BadRequestException('Too many files'))).toBeInstanceOf(PayloadTooLargeException);
    expect(String((mapUploadError(new BadRequestException('Too many files')) as Error).message)).toMatch(/Up to 10 files/);
    const parts = mapUploadError(new BadRequestException('Too many parts'));
    expect(parts).toBeInstanceOf(BadRequestException);
    expect(String((parts as Error).message)).toMatch(/too many fields/i);
    const other = new BadRequestException('nope');
    expect(mapUploadError(other)).toBe(other);
    const plain = new Error('x');
    expect(mapUploadError(plain)).toBe(plain);
  });

  it('cleanMarkdown: autolinks survive, https images are unwrapped, reference definitions are gated, escaped prose and unclosed "<" stay', () => {
    expect(cleanMarkdown('see <https://example.com> now', { maxLen: 100 })).toBe('see <https://example.com> now');
    expect(cleanMarkdown('see <http://example.com> now', { maxLen: 100 })).toBe('see http://example.com now');
    expect(cleanMarkdown('![px](https://tracker.test/px.png) text', { maxLen: 100 })).toBe('px text');
    expect(cleanMarkdown('[site](https://example.com)', { maxLen: 100 })).toBe('[site](https://example.com)');
    expect(cleanMarkdown('[x]: javascript:alert(1)\n\n[a][x]', { maxLen: 100 })).toBe('[a][x]');
    expect(cleanMarkdown('[ok]: https://example.com "t"\n\n[a][ok]', { maxLen: 100 })).toBe('[ok]: https://example.com "t"\n\n[a][ok]');
    expect(cleanMarkdown('type &lt;br&gt; to show it literally', { maxLen: 100 })).toBe('type &lt;br&gt; to show it literally');
    expect(cleanMarkdown('if a <b then c', { maxLen: 100 })).toBe('if a <b then c');
    expect(cleanMarkdown('&lt;script&gt;x&lt;/script&gt;', { maxLen: 100 })).toBe('&lt;script&gt;x&lt;/script&gt;');
    expect(cleanMarkdown('fish & chips <b>bold</b> <img src=x onerror=alert(1)>', { maxLen: 100 })).toBe('fish & chips bold');
  });
});
