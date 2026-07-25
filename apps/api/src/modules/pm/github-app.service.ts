import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * GitHub App client (PRD v6 §12) — RS256 App JWT + installation-token cache
 * over plain fetch. No SDK: the three calls we make don't justify octokit,
 * and the JWT is 15 lines of node crypto (house hand-rolled style, like the
 * svix verify). Every method is a graceful no-op when the App env vars are
 * absent — CI and fixture tests never depend on live credentials.
 */

const API = 'https://api.github.com';
const TOKEN_TTL_SLACK_MS = 60_000; // refresh 1 min before expiry

interface CachedToken {
  token: string;
  expiresAt: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

@Injectable()
export class GithubAppService {
  private readonly logger = new Logger(GithubAppService.name);
  private readonly tokenCache = new Map<number, CachedToken>();

  constructor(private readonly config: ConfigService) {}

  get appId(): string | null {
    return this.config.get<string>('GITHUB_APP_ID') || null;
  }

  private privateKey(): string | null {
    // Key arrives via env with literal \n escapes (single-line .env value).
    const raw = this.config.get<string>('GITHUB_APP_PRIVATE_KEY') || '';
    return raw ? raw.replace(/\\n/g, '\n') : null;
  }

  get configured(): boolean {
    return !!(this.appId && this.privateKey());
  }

  /** Short-lived RS256 App JWT (§12.1) — iss = app id, 9-minute lifetime. */
  appJwt(): string | null {
    const key = this.privateKey();
    const iss = this.appId;
    if (!key || !iss) return null;
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    // iat backdated 60s against clock drift (GitHub's documented guidance).
    const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss }));
    const signature = crypto
      .createSign('RSA-SHA256')
      .update(`${header}.${payload}`)
      .sign(key, 'base64url');
    return `${header}.${payload}.${signature}`;
  }

  /** Installation access token, cached until shortly before expiry. */
  async installationToken(installationId: number): Promise<string | null> {
    const cached = this.tokenCache.get(installationId);
    if (cached && cached.expiresAt - TOKEN_TTL_SLACK_MS > Date.now()) return cached.token;
    const jwt = this.appJwt();
    if (!jwt) return null;
    try {
      const res = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'flicks-suite-pm',
        },
      });
      if (!res.ok) {
        this.logger.warn(`installation token ${installationId} → ${res.status}`);
        return null;
      }
      const body = (await res.json()) as { token: string; expires_at: string };
      this.tokenCache.set(installationId, {
        token: body.token,
        expiresAt: new Date(body.expires_at).getTime(),
      });
      return body.token;
    } catch (err) {
      this.logger.warn(`installation token ${installationId} failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /** Installation metadata (used to verify a claim). Null when unconfigured. */
  async getInstallation(installationId: number): Promise<{ account_login: string } | null> {
    const jwt = this.appJwt();
    if (!jwt) return null;
    try {
      const res = await fetch(`${API}/app/installations/${installationId}`, {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'flicks-suite-pm',
        },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { account?: { login?: string } };
      return { account_login: body.account?.login ?? 'unknown' };
    } catch {
      return null;
    }
  }

  /** Best-effort PR comment (bot link-back, §12.4). Never throws. */
  async commentOnPr(
    installationId: number,
    repoFullName: string,
    prNumber: number,
    body: string,
  ): Promise<boolean> {
    const token = await this.installationToken(installationId);
    if (!token) return false;
    try {
      const res = await fetch(`${API}/repos/${repoFullName}/issues/${prNumber}/comments`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'flicks-suite-pm',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
