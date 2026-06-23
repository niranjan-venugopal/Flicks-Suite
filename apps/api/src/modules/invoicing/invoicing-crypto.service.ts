import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'crypto';

/**
 * AES-256-GCM encryption for per-tenant Razorpay OAuth tokens at rest
 * (Sprint 15). Mirrors TotpService: the key is derived from
 * INVOICING_SECRET_ENC_KEY with a fixed salt, and the service degrades to a
 * plaintext passthrough when the key is unset (local/CI), tolerating
 * plaintext-or-ciphertext on read so a key can be introduced without a backfill.
 */
@Injectable()
export class InvoicingCryptoService {
  private readonly key: Buffer | null;

  constructor(private readonly config: ConfigService) {
    const secret = this.config.get<string>('INVOICING_SECRET_ENC_KEY');
    this.key = secret ? scryptSync(secret, 'flicks-invoicing-v1', 32) : null;
  }

  /** AES-256-GCM. Returns iv:tag:ciphertext (hex) or the plaintext if no key. */
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
    if (!ivHex || !tagHex || !dataHex) {
      // Not in our encrypted format (e.g. legacy plaintext) — return as-is.
      return stored;
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(ivHex, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  }
}
