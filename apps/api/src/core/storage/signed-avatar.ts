import { Logger } from '@nestjs/common';
import { R2Service } from './r2.service';

// ─────────────────────────────────────────────────────────────────────────────
// Round N — the ONE shared avatar-serialization primitive.
//
// The photo upload writes `users.avatar_key` only (a private R2 key,
// `users/<id>/avatar/<uuid>_{256|64}.webp`); `users.avatar_url` is the legacy
// public-URL column kept as a read fallback. Every surface that shows a face
// must therefore join `users` and turn the key into a signed URL — a surface
// that skips this shows initials forever (the founder-round8 bug class, hit
// again in Round N on the Team attendance list).
//
// This lives in core/ (shared by design per the dependency-cruiser header) so
// modules that must not import MediaModule — audit would create the cycle
// media → audit → media — can still sign with only the global R2Service.
// MediaService.servedUrl delegates here, so the two paths cannot drift.
// Signing is local SigV4 crypto (no network, no DB), safe inside or outside a
// tenant transaction; prefer after the tx returns, like PM does.
// ─────────────────────────────────────────────────────────────────────────────

const logger = new Logger('SignedAvatar');

/** Signed URL for a stored avatar key, or the legacy URL fallback (§4/D6). */
export async function servedAvatarUrl(
  r2: R2Service | undefined,
  key: string | null,
  legacyUrl: string | null,
  size: 256 | 64 = 256,
): Promise<string | null> {
  if (key && r2?.isConfigured()) {
    const k = size === 64 ? key.replace('_256.webp', '_64.webp') : key;
    try {
      return await r2.signedGetUrl(k);
    } catch (err) {
      logger.warn(`signedGetUrl failed for ${k}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return legacyUrl;
}

/**
 * Strip-and-sign row mapper: replaces each row's `avatarKey` with a signed
 * `avatarUrl` (falling back to the row's legacy `avatarUrl`). The key never
 * reaches a response. `sign` is the module's signer — typically
 * `(k, l) => this.mediaService ? this.mediaService.servedUrl(k, l, 64) : Promise.resolve(l)`
 * so hand-built specs without DI keep working on the legacy column.
 */
export async function withSignedAvatars<
  T extends { avatarKey?: string | null; avatarUrl?: string | null },
>(
  sign: (key: string | null, legacyUrl: string | null) => Promise<string | null>,
  rows: T[],
): Promise<Omit<T, 'avatarKey'>[]> {
  return Promise.all(
    rows.map(async ({ avatarKey, ...row }) => ({
      ...(row as Omit<T, 'avatarKey'>),
      avatarUrl: await sign(avatarKey ?? null, (row as { avatarUrl?: string | null }).avatarUrl ?? null),
    })),
  );
}
