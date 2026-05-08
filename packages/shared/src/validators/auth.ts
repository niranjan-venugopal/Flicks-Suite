import { z } from 'zod';

// ─── Auth Validators ──────────────────────────────────────────────────────────

export const RequestOtpSchema = z.object({
  email: z.string().email('Please enter a valid email address').toLowerCase(),
});

export const VerifyOtpSchema = z.object({
  email: z.string().email('Please enter a valid email address').toLowerCase(),
  code: z
    .string()
    .length(6, 'OTP must be exactly 6 digits')
    .regex(/^\d{6}$/, 'OTP must contain only digits'),
});

export const SelectTenantSchema = z.object({
  tenantId: z.string().uuid('Invalid tenant ID'),
});

export const RequestMagicLinkSchema = z.object({
  email: z.string().email('Please enter a valid email address').toLowerCase(),
});

export const RefreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
  deviceId: z.string().min(1, 'Device ID is required'),
});

export const RevokeDeviceSchema = z.object({
  deviceId: z.string().min(1, 'Device ID is required'),
});

// ─── Inferred Types ───────────────────────────────────────────────────────────

export type RequestOtpDto = z.infer<typeof RequestOtpSchema>;
export type VerifyOtpDto = z.infer<typeof VerifyOtpSchema>;
export type SelectTenantDto = z.infer<typeof SelectTenantSchema>;
export type RequestMagicLinkDto = z.infer<typeof RequestMagicLinkSchema>;
export type RefreshTokenDto = z.infer<typeof RefreshTokenSchema>;
export type RevokeDeviceDto = z.infer<typeof RevokeDeviceSchema>;
