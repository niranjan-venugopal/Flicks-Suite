import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'crypto';

/**
 * Per-purpose AES-256-GCM at rest (PRD v5 §13 "per-purpose keys"). Mirrors the
 * proven InvoicingCryptoService format (iv:tag:ciphertext hex; degrades to
 * plaintext when the purpose's env key is unset — dev convenience, flagged in
 * .env.example). Each purpose derives an independent key from its own secret,
 * so leaking one never unlocks another.
 *
 * Purposes in v5: 'webhook'  → WEBHOOK_SECRET_ENC_KEY
 *                 'email'    → EMAIL_TOKEN_KEY      (Phase B OAuth tokens)
 */
const PURPOSE_ENV: Record<string, string> = {
  webhook: 'WEBHOOK_SECRET_ENC_KEY',
  email: 'EMAIL_TOKEN_KEY',
};

@Injectable()
export class AppCryptoService {
  private readonly keys = new Map<string, Buffer | null>();

  constructor(private readonly config: ConfigService) {}

  private keyFor(purpose: string): Buffer | null {
    if (!this.keys.has(purpose)) {
      const env = PURPOSE_ENV[purpose];
      const secret = env ? this.config.get<string>(env) : undefined;
      this.keys.set(
        purpose,
        secret ? scryptSync(secret, `flicks-${purpose}-v1`, 32) : null,
      );
    }
    return this.keys.get(purpose) ?? null;
  }

  encrypt(plain: string, purpose: keyof typeof PURPOSE_ENV | string): string {
    const key = this.keyFor(purpose);
    if (!key) return plain;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
  }

  decrypt(stored: string, purpose: keyof typeof PURPOSE_ENV | string): string {
    const key = this.keyFor(purpose);
    if (!key) return stored;
    const [ivHex, tagHex, dataHex] = stored.split(':');
    if (!ivHex || !tagHex || !dataHex) return stored; // legacy/plaintext
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(ivHex, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  }
}
