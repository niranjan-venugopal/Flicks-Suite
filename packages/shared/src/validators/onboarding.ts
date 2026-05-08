import { z } from 'zod';

// ─── Regex Constants ──────────────────────────────────────────────────────────

export const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
export const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

// ─── Slug Validator ───────────────────────────────────────────────────────────

export const SlugSchema = z
  .string()
  .min(3, 'Slug must be at least 3 characters')
  .max(80, 'Slug must be at most 80 characters')
  .regex(
    /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/,
    'Slug must contain only lowercase letters, numbers, and hyphens, and cannot start or end with a hyphen',
  );

// ─── Tenant Creation ──────────────────────────────────────────────────────────

export const CreateTenantSchema = z.object({
  name: z
    .string()
    .min(2, 'Workspace name must be at least 2 characters')
    .max(100, 'Workspace name must be at most 100 characters')
    .trim(),
  slug: SlugSchema,
  yourName: z
    .string()
    .min(2, 'Your name must be at least 2 characters')
    .max(100, 'Your name must be at most 100 characters')
    .trim(),
});

// ─── Tenant Details (Onboarding Step) ────────────────────────────────────────

const AddressSchema = z.object({
  line1: z.string().min(1, 'Address line 1 is required').trim(),
  line2: z.string().optional(),
  city: z.string().min(1, 'City is required').trim(),
  state: z.string().min(1, 'State is required').trim(),
  postal: z
    .string()
    .regex(/^\d{6}$/, 'Enter a valid 6-digit PIN code'),
  country: z.string().min(1, 'Country is required').default('India'),
});

export const TenantDetailsSchema = z.object({
  legalName: z
    .string()
    .min(2, 'Legal name must be at least 2 characters')
    .max(200, 'Legal name must be at most 200 characters')
    .trim(),
  gstin: z
    .string()
    .toUpperCase()
    .regex(GSTIN_REGEX, 'Enter a valid GSTIN (e.g. 29ABCDE1234F1Z5)')
    .optional()
    .or(z.literal('')),
  pan: z
    .string()
    .toUpperCase()
    .regex(PAN_REGEX, 'Enter a valid PAN (e.g. ABCDE1234F)')
    .optional()
    .or(z.literal('')),
  address: AddressSchema,
  cin: z
    .string()
    .regex(
      /^[UL][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/,
      'Enter a valid CIN',
    )
    .optional()
    .or(z.literal('')),
  website: z.string().url('Enter a valid URL').optional().or(z.literal('')),
  phone: z
    .string()
    .regex(/^\+?[1-9]\d{1,14}$/, 'Enter a valid phone number')
    .optional()
    .or(z.literal('')),
});

// ─── Inferred Types ───────────────────────────────────────────────────────────

export type CreateTenantDto = z.infer<typeof CreateTenantSchema>;
export type TenantDetailsDto = z.infer<typeof TenantDetailsSchema>;
export type SlugDto = z.infer<typeof SlugSchema>;
