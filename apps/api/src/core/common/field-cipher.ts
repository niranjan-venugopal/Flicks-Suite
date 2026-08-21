import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

/**
 * AES-256-GCM field-level cipher for sensitive at-rest columns (PAN, bank
 * account numbers, …). Same shape as the TotpService cipher: the key is
 * derived from a configured secret via scrypt; when no secret is configured
 * (local dev) both directions pass values through unchanged, and decrypt
 * gracefully returns legacy plaintext rows as-is (they predate encryption).
 *
 * Stored format: iv:tag:ciphertext (hex).
 */
export class FieldCipher {
  private readonly key: Buffer | null;

  constructor(secret: string | undefined | null, saltLabel: string) {
    this.key = secret ? scryptSync(secret, saltLabel, 32) : null;
  }

  get enabled(): boolean {
    return this.key !== null;
  }

  encrypt(plain: string): string {
    if (!this.key) return plain;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
  }

  decrypt(stored: string): string {
    if (!this.key) return stored;
    const [ivHex, tagHex, dataHex] = stored.split(':');
    if (!ivHex || !tagHex || !dataHex) return stored; // legacy plaintext row
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      return Buffer.concat([
        decipher.update(Buffer.from(dataHex, 'hex')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return stored;
    }
  }
}
