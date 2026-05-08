import { z } from 'zod';

// ─── Attendance Validators ────────────────────────────────────────────────────

export const PunchInSchema = z.object({
  lat: z
    .number()
    .min(-90, 'Latitude must be between -90 and 90')
    .max(90, 'Latitude must be between -90 and 90')
    .optional(),
  lng: z
    .number()
    .min(-180, 'Longitude must be between -180 and 180')
    .max(180, 'Longitude must be between -180 and 180')
    .optional(),
  accuracy: z
    .number()
    .positive('Accuracy must be a positive number')
    .optional(),
  locationId: z.string().uuid('Invalid location ID').optional(),
});

export const RegularizationSchema = z
  .object({
    attendanceDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Attendance date must be in YYYY-MM-DD format'),
    requestType: z.enum([
      'missing_punch',
      'wrong_punch',
      'forgot_punch_in',
      'forgot_punch_out',
      'full_day_correction',
      'on_duty',
    ]),
    proposedInTime: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/, 'Invalid datetime format')
      .optional(),
    proposedOutTime: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/, 'Invalid datetime format')
      .optional(),
    reason: z
      .string()
      .min(10, 'Reason must be at least 10 characters')
      .max(500, 'Reason must be at most 500 characters')
      .trim(),
  })
  .refine(
    (data) => {
      if (data.proposedInTime && data.proposedOutTime) {
        return new Date(data.proposedOutTime) > new Date(data.proposedInTime);
      }
      return true;
    },
    {
      message: 'Proposed out time must be after proposed in time',
      path: ['proposedOutTime'],
    },
  );

// ─── Inferred Types ───────────────────────────────────────────────────────────

export type PunchInDto = z.infer<typeof PunchInSchema>;
export type RegularizationDto = z.infer<typeof RegularizationSchema>;
