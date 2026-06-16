-- 0020_account_security.sql
-- Sprint 13 §E — TOTP brute-force lockout + single-use backup codes.
-- Additive + idempotent. No RLS change (users keeps its existing policy; TOTP
-- columns are read/written via the service-role connection in auth.service).

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_failed_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_locked_until timestamptz;
-- Array of { h: sha256(code), u: ISO-used-at | null }. Codes are shown once at
-- enrolment and stored only as hashes.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_backup_codes jsonb;
