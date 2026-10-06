/**
 * Encryption-key boot guard (security audit 2026-10-06 follow-up). main.ts
 * refuses to start in production when this returns any name; the predicate
 * must stay identical to the warning the founder's keys passed (length ≥ 32,
 * no trimming), so a confirmed key can never start failing the boot.
 */
import {
  MIN_ENCRYPTION_KEY_LENGTH,
  REQUIRED_ENCRYPTION_KEYS,
  missingEncryptionKeys,
} from '../core/config/encryption-keys';

const env = (vals: Record<string, string | undefined>) => (k: string) => vals[k];

describe('missingEncryptionKeys', () => {
  const strong = 'k'.repeat(64);

  it('guards exactly the three field-encryption keys at 32 characters', () => {
    expect([...REQUIRED_ENCRYPTION_KEYS]).toEqual([
      'EMPLOYEE_DATA_ENC_KEY',
      'TOTP_SECRET',
      'INVOICING_SECRET_ENC_KEY',
    ]);
    expect(MIN_ENCRYPTION_KEY_LENGTH).toBe(32);
  });

  it('passes when all three are set and long enough', () => {
    expect(
      missingEncryptionKeys(
        env({ EMPLOYEE_DATA_ENC_KEY: strong, TOTP_SECRET: strong, INVOICING_SECRET_ENC_KEY: strong }),
      ),
    ).toEqual([]);
  });

  it('names every missing or blank key', () => {
    expect(missingEncryptionKeys(env({}))).toEqual([...REQUIRED_ENCRYPTION_KEYS]);
    expect(
      missingEncryptionKeys(env({ EMPLOYEE_DATA_ENC_KEY: '', TOTP_SECRET: strong })),
    ).toEqual(['EMPLOYEE_DATA_ENC_KEY', 'INVOICING_SECRET_ENC_KEY']);
  });

  it('treats 31 characters as missing and 32 as set (boundary)', () => {
    const vals = {
      EMPLOYEE_DATA_ENC_KEY: 'a'.repeat(31),
      TOTP_SECRET: 'b'.repeat(32),
      INVOICING_SECRET_ENC_KEY: strong,
    };
    expect(missingEncryptionKeys(env(vals))).toEqual(['EMPLOYEE_DATA_ENC_KEY']);
  });

  it('does not trim — the exact predicate the confirmed keys passed', () => {
    const padded = ` ${'c'.repeat(30)} `; // 32 chars incl. spaces
    expect(
      missingEncryptionKeys(
        env({ EMPLOYEE_DATA_ENC_KEY: padded, TOTP_SECRET: strong, INVOICING_SECRET_ENC_KEY: strong }),
      ),
    ).toEqual([]);
  });

  it('returns names only, never values', () => {
    const secret = 'z'.repeat(10);
    const out = missingEncryptionKeys(
      env({ EMPLOYEE_DATA_ENC_KEY: secret, TOTP_SECRET: secret, INVOICING_SECRET_ENC_KEY: secret }),
    );
    expect(out.join(' ')).not.toContain(secret);
  });
});
