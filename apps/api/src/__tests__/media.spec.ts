import 'dotenv/config';
import sharp from 'sharp';
import { dbAdmin } from '@flicks/db';
import { MediaService } from '../modules/media/media.service';
import { R2Service } from '../core/storage/r2.service';

/**
 * PRD v4 §4 — media pipeline validation (Sprint 17). The server judges files
 * by MAGIC BYTES; SVG and undersized images are rejected before any R2 work,
 * so these paths test without storage configured.
 */

const config = { get: (_: string, fb?: unknown) => fb } as never;
const audit = { log: async () => {} } as never;
const r2 = new R2Service(config); // unconfigured — storage-less paths only
const media = new MediaService(dbAdmin as never, r2, audit);

// access the private validator via a typed cast — validation is the unit here
const validate = (buf: Buffer) =>
  (media as unknown as { validate: (b: Buffer) => Promise<void> }).validate(buf);

afterAll(async () => {
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('Media pipeline validation (PRD v4 §4)', () => {
  it('rejects SVG regardless of what the client claims (magic bytes, XSS surface)', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    await expect(validate(svg)).rejects.toThrow(/isn.t supported/);
  });

  it('rejects a spoofed extension: text bytes are judged by content, not name', async () => {
    const fake = Buffer.from('definitely-not-an-image.png contents');
    await expect(validate(fake)).rejects.toThrow(/isn.t supported/);
  });

  it('rejects images under 128px', async () => {
    const tiny = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#3E7BFA' },
    })
      .png()
      .toBuffer();
    await expect(validate(tiny)).rejects.toThrow(/too small/);
  });

  it('rejects oversize payloads before decoding', async () => {
    const big = Buffer.alloc(9 * 1024 * 1024, 1);
    await expect(validate(big)).rejects.toThrow(/too large/);
  });

  it('accepts a valid PNG ≥128px', async () => {
    const ok = await sharp({
      create: { width: 256, height: 256, channels: 3, background: '#27D280' },
    })
      .png()
      .toBuffer();
    await expect(validate(ok)).resolves.toBeUndefined();
  });

  it('servedUrl falls back to the legacy URL when storage is unconfigured', async () => {
    const url = await media.servedUrl('users/x/avatar/abc_256.webp', 'https://legacy/a.png');
    expect(url).toBe('https://legacy/a.png');
    expect(await media.servedUrl(null, null)).toBeNull();
  });
});
