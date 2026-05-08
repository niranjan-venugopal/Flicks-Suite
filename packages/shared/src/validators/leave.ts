import { z } from 'zod';

// ─── Leave Validators ─────────────────────────────────────────────────────────

export const ApplyLeaveSchema = z
  .object({
    leaveTypeId: z.string().uuid('Invalid leave type ID'),
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Start date must be in YYYY-MM-DD format'),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'End date must be in YYYY-MM-DD format'),
    isHalfDay: z.boolean().default(false),
    halfDaySession: z
      .enum(['first_half', 'second_half'])
      .optional(),
    reason: z
      .string()
      .min(10, 'Reason must be at least 10 characters')
      .max(500, 'Reason must be at most 500 characters')
      .trim(),
    coverEmployeeId: z.string().uuid('Invalid cover employee ID').optional(),
    documentUrls: z.array(z.string().url('Invalid document URL')).default([]),
  })
  .refine(
    (data) => {
      const start = new Date(data.startDate);
      const end = new Date(data.endDate);
      return end >= start;
    },
    {
      message: 'End date must be on or after start date',
      path: ['endDate'],
    },
  )
  .refine(
    (data) => {
      if (data.isHalfDay && !data.halfDaySession) {
        return false;
      }
      return true;
    },
    {
      message: 'Half day session must be specified when applying for half day leave',
      path: ['halfDaySession'],
    },
  )
  .refine(
    (data) => {
      if (data.isHalfDay) {
        return data.startDate === data.endDate;
      }
      return true;
    },
    {
      message: 'Half day leave must have the same start and end date',
      path: ['endDate'],
    },
  );

// ─── Leave Cancellation ───────────────────────────────────────────────────────

export const CancelLeaveSchema = z.object({
  leaveRequestId: z.string().uuid('Invalid leave request ID'),
  reason: z
    .string()
    .min(5, 'Cancellation reason must be at least 5 characters')
    .max(500)
    .trim()
    .optional(),
});

// ─── Leave Approval / Rejection ───────────────────────────────────────────────

export const ReviewLeaveSchema = z.object({
  leaveRequestId: z.string().uuid('Invalid leave request ID'),
  action: z.enum(['approve', 'reject']),
  comment: z
    .string()
    .max(500)
    .trim()
    .optional(),
});

// ─── Inferred Types ───────────────────────────────────────────────────────────

export type ApplyLeaveDto = z.infer<typeof ApplyLeaveSchema>;
export type CancelLeaveDto = z.infer<typeof CancelLeaveSchema>;
export type ReviewLeaveDto = z.infer<typeof ReviewLeaveSchema>;
