-- 0057 — removing an employee (founder round 21).
--
-- Employees had no delete at all: 22 routes on the controller, none of them a
-- delete, and no column to mark one. The only exit path was `terminate`, which
-- moves someone to notice period and was never given a button.
--
-- Why a soft delete and not a real one for anyone with history: FOURTEEN tables
-- CASCADE off employees.id —
--   emergency_contacts · employee_documents · employee_invitations ·
--   employment_history · employee_shifts · attendance_regularizations ·
--   attendance_records · attendance_punches · leave_balances · leave_requests ·
--   calendar_events · timesheet_periods · timesheet_entries ·
--   employee_change_requests
-- so a plain DELETE silently destroys the whole attendance, leave, timesheet and
-- employment record of a person, with no code involved. Those rows are the
-- substrate of PF/ESI returns, wage registers and Form 16, which an Indian
-- employer has to be able to produce years later.
--
-- So the rule (the same one already shipped for invoicing clients in 0055):
--   * no history at all  -> a real DELETE; nothing exists, nothing is lost
--   * any history        -> stamp deleted_at; they leave every screen exactly
--                           as if deleted, and the statutory rows survive
-- Restore just clears the stamp.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Every directory-shaped read is "live employees in this tenant, by status" —
-- the list, org chart, people pickers, headcount tiles and the admin
-- attendance/leave/timesheet screens. Partial, so the index holds only the
-- rows those queries can actually return.
CREATE INDEX IF NOT EXISTS idx_employees_tenant_live
  ON employees (tenant_id, status)
  WHERE deleted_at IS NULL;
