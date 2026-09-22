/**
 * Round N — module-local avatar mapper for CRM's snake_case person rows.
 *
 * The photo upload writes only `users.avatar_key` (a private R2 key), so every
 * CRM list that shows a person joins `users` and selects the
 * `<who>_avatar_key` / `<who>_avatar_url` pair; this mapper then REMOVES the
 * key field (a raw key must never reach a response) and overwrites the url
 * field with sign(key, legacy url). The signer is the per-service lambda
 * (`MediaService.servedUrl(k, l, 64)` when injected, legacy-url fallback in
 * hand-built specs), which never throws — signing must never fail a read.
 */
export type AvatarSigner = (
  key: string | null,
  legacyUrl: string | null,
) => Promise<string | null>;

/**
 * `keyField` / `urlField` are constrained to keys the row actually HAS. Without
 * that a mistyped field name compiles, the destructure below finds nothing, and
 * the real key rides along in `...rest` all the way to the client — the exact
 * leak this helper exists to prevent. The defaults intersect with `keyof T` so
 * the common (no-opts) call keeps inferring `owner_avatar_key` unchanged.
 */
export async function signOwnerAvatars<
  T extends Record<string, unknown>,
  K extends Extract<keyof T, string> = Extract<keyof T, string> & 'owner_avatar_key',
  U extends Extract<keyof T, string> = Extract<keyof T, string> & 'owner_avatar_url',
>(
  sign: AvatarSigner,
  rows: T[],
  opts: { keyField?: K; urlField?: U } = {},
): Promise<Array<Omit<T, K> & Record<U, string | null>>> {
  const keyField = (opts.keyField ?? 'owner_avatar_key') as K;
  const urlField = (opts.urlField ?? 'owner_avatar_url') as U;
  return Promise.all(
    rows.map(async (row) => {
      const { [keyField]: key, ...rest } = row;
      const legacy = (rest as Record<string, unknown>)[urlField];
      return {
        ...rest,
        [urlField]: await sign(
          typeof key === 'string' ? key : null,
          typeof legacy === 'string' ? legacy : null,
        ),
      } as Omit<T, K> & Record<U, string | null>;
    }),
  );
}
