import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { authenticator } from 'otplib';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'crypto';

const ISSUER = 'Flicks Suite FAM';

/**
 * FAM (platform-admin) second factor. Wraps otplib for TOTP generation /
 * verification and encrypts the per-user secret at rest with TOTP_SECRET.
 *
 * Enforcement is opt-in: when TOTP_SECRET is unset (local dev) isEnforced()
 * is false and the auth flow skips the second factor entirely.
 */
@Injectable()
export class TotpService {
  private readonly logger = new Logger(TotpService.name);
  private readonly key: Buffer | null;

  constructor(private readonly config: ConfigService) {
    const secret = this.config.get<string>('TOTP_SECRET');
    // Derive a stable 32-byte key from the configured secret. scrypt with a
    // fixed salt is fine here — the input secret is already high-entropy.
    this.key = secret
      ? scryptSync(secret, 'flicks-totp-v1', 32)
      : null;
  }

  isEnforced(): boolean {
    return this.key !== null;
  }

  generateSecret(): string {
    return authenticator.generateSecret();
  }

  /** otpauth:// URI for QR rendering in an authenticator app. */
  keyUri(email: string, secret: string): string {
    return authenticator.keyuri(email, ISSUER, secret);
  }

  verify(code: string, secret: string): boolean {
    try {
      return authenticator.verify({ token: code.trim(), secret });
    } catch {
      return false;
    }
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
