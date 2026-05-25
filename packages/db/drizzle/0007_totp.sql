-- 0007_totp.sql
-- FAM (platform-admin) second factor. FAM logins are gated on totp_secret
-- being non-null (PRD §11.6). Customer users never set these.

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enrolled_at timestamptz;
