/**
 * Security audit 2026-10-06: the field ciphers pass values through in PLAIN
 * TEXT when their key is blank (PAN / passport / bank numbers, the Razorpay
 * tokens), and a blank TOTP_SECRET switches platform-admin 2FA off. In
 * production the API refuses to boot unless all three are set (main.ts).
 *
 * The predicate is deliberately the exact one the boot warning used when the
 * founder confirmed the keys (2026-10-06): no trimming or other reshaping, so
 * a key that passed then still passes now. Names only — values are never
 * returned or logged.
 */
export const REQUIRED_ENCRYPTION_KEYS = [
  'EMPLOYEE_DATA_ENC_KEY',
  'TOTP_SECRET',
  'INVOICING_SECRET_ENC_KEY',
] as const;

export const MIN_ENCRYPTION_KEY_LENGTH = 32;

/** Names of the required keys that are missing or shorter than 32 characters. */
export function missingEncryptionKeys(get: (name: string) => string | undefined): string[] {
  return REQUIRED_ENCRYPTION_KEYS.filter(
    (k) => (get(k) ?? '').length < MIN_ENCRYPTION_KEY_LENGTH,
  );
}
