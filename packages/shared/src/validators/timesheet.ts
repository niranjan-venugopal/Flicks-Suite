import { z } from 'zod';

// ─── Timesheet Validators ─────────────────────────────────────────────────────

export const TimesheetEntrySchema = z.object({
  entryDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Entry date must be in YYYY-MM-DD format'),
  hours: z
    .number()
    .min(0, 'Hours cannot be negative')
    .max(24, 'Hours cannot exceed 24 per day')
    .multipleOf(0.25, 'Hours must be in 15-minute increments (e.g. 0.25, 0.5, 0.75)'),
  category: z.enum([
    'development',
    'design',
    'meeting',
    'research',
    'testing',
    'documentation',
    'support',
    'training',
    'administrative',
    'other',
  ]),
  isBillable: z.boolean().default(false),
  description: z
    .string()
    .max(500, 'Description must be at most 500 characters')
    .trim()
    .optional(),
  projectId: z.string().uuid('Invalid project ID').optional(),
  taskId: z.string().uuid('Invalid task ID').optional(),
});

export const BulkSaveEntriesSchema = z.object({
  timesheetPeriodId: z.string().uuid('Invalid timesheet period ID'),
  entries: z
    .array(TimesheetEntrySchema)
    .min(1, 'At least one entry is required')
    .max(31, 'Cannot submit more than 31 entries at a time'),
});

export const SubmitTimesheetSchema = z.object({
  timesheetPeriodId: z.string().uuid('Invalid timesheet period ID'),
});

export const ReviewTimesheetSchema = z.object({
  timesheetPeriodId: z.string().uuid('Invalid timesheet period ID'),
  action: z.enum(['approve', 'reject', 'rework']),
  comment: z
    .string()
    .max(500)
    .trim()
    .optional(),
});

// ─── Inferred Types ───────────────────────────────────────────────────────────

export type TimesheetEntryDto = z.infer<typeof TimesheetEntrySchema>;
export type BulkSaveEntriesDto = z.infer<typeof BulkSaveEntriesSchema>;
export type SubmitTimesheetDto = z.infer<typeof SubmitTimesheetSchema>;
export type ReviewTimesheetDto = z.infer<typeof ReviewTimesheetSchema>;
