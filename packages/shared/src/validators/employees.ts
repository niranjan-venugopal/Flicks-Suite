import { z } from 'zod';
import { IFSC_REGEX, PAN_REGEX } from '../constants/index';

// ─── Invite Employee ──────────────────────────────────────────────────────────

export const InviteEmployeeSchema = z.object({
  firstName: z
    .string()
    .min(1, 'First name is required')
    .max(50, 'First name must be at most 50 characters')
    .trim(),
  lastName: z
    .string()
    .min(1, 'Last name is required')
    .max(50, 'Last name must be at most 50 characters')
    .trim(),
  workEmail: z
    .string()
    .email('Enter a valid work email address')
    .toLowerCase()
    .trim(),
  designation: z
    .string()
    .min(1, 'Designation is required')
    .max(100, 'Designation must be at most 100 characters')
    .trim(),
  department: z
    .string()
    .min(1, 'Department is required')
    .max(100, 'Department must be at most 100 characters')
    .trim(),
  reportingManagerId: z.string().uuid('Invalid manager ID').optional(),
  dateOfJoining: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date of joining must be in YYYY-MM-DD format'),
  employmentType: z.enum(['full_time', 'part_time', 'contractor', 'intern', 'consultant']),
  locationId: z.string().uuid('Invalid location ID').optional(),
  sendInvite: z.boolean().default(true),
});

// ─── Onboarding Step 1 — Personal Info ───────────────────────────────────────

const eighteenYearsAgo = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 18);
  return d;
};

export const OnboardingStep1Schema = z.object({
  firstName: z
    .string()
    .min(1, 'First name is required')
    .max(50)
    .trim(),
  lastName: z
    .string()
    .min(1, 'Last name is required')
    .max(50)
    .trim(),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date of birth must be in YYYY-MM-DD format')
    .refine((val) => {
      const dob = new Date(val);
      return dob <= eighteenYearsAgo();
    }, 'You must be at least 18 years old'),
  gender: z.enum(['male', 'female', 'non_binary', 'prefer_not_to_say']),
  maritalStatus: z.enum(['single', 'married', 'divorced', 'widowed', 'separated']),
  nationality: z
    .string()
    .min(1, 'Nationality is required')
    .max(50)
    .trim()
    .default('Indian'),
  bloodGroup: z
    .enum(['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'])
    .optional(),
  personalMobile: z
    .string()
    .regex(/^\+?[1-9]\d{9,14}$/, 'Enter a valid mobile number')
    .optional()
    .or(z.literal('')),
  personalEmail: z
    .string()
    .email('Enter a valid personal email')
    .toLowerCase()
    .optional()
    .or(z.literal('')),
  avatar: z
    .string()
    .url('Avatar must be a valid URL')
    .optional()
    .or(z.literal('')),
});

// ─── Onboarding Step 2 — Address ─────────────────────────────────────────────

const AddressSchema = z.object({
  line1: z.string().min(1, 'Address line 1 is required').max(200).trim(),
  line2: z.string().max(200).trim().optional(),
  city: z.string().min(1, 'City is required').max(100).trim(),
  state: z.string().min(1, 'State is required').max(100).trim(),
  postal: z
    .string()
    .regex(/^\d{6}$/, 'Enter a valid 6-digit PIN code'),
  country: z.string().min(1, 'Country is required').max(100).trim().default('India'),
});

export const OnboardingStep2Schema = z.object({
  currentAddress: AddressSchema,
  sameAsCurrent: z.boolean().default(false),
  permanentAddress: AddressSchema.optional(),
}).refine(
  (data) => data.sameAsCurrent || data.permanentAddress !== undefined,
  {
    message: 'Permanent address is required when not same as current address',
    path: ['permanentAddress'],
  },
);

// ─── Onboarding Step 3 — Emergency Contact ───────────────────────────────────

export const OnboardingStep3Schema = z.object({
  emergencyContact: z.object({
    name: z
      .string()
      .min(1, 'Contact name is required')
      .max(100)
      .trim(),
    relationship: z.enum(['spouse', 'parent', 'sibling', 'child', 'friend', 'colleague', 'other']),
    phone: z
      .string()
      .regex(/^\+?[1-9]\d{9,14}$/, 'Enter a valid phone number'),
    email: z
      .string()
      .email('Enter a valid email address')
      .toLowerCase()
      .optional()
      .or(z.literal('')),
  }),
});

// ─── Onboarding Step 4 — Identity & Banking ──────────────────────────────────

export const IfscValidator = z
  .string()
  .length(11, 'IFSC code must be exactly 11 characters')
  .regex(IFSC_REGEX, 'Enter a valid IFSC code (e.g. SBIN0001234)');

export const OnboardingStep4Schema = z.object({
  pan: z
    .string()
    .toUpperCase()
    .regex(PAN_REGEX, 'Enter a valid PAN (e.g. ABCDE1234F)')
    .optional()
    .or(z.literal('')),
  aadhaarLast4: z
    .string()
    .regex(/^\d{4}$/, 'Enter the last 4 digits of your Aadhaar')
    .optional()
    .or(z.literal('')),
  bankAccountHolder: z
    .string()
    .min(1, 'Account holder name is required')
    .max(100)
    .trim(),
  bankAccountNumber: z
    .string()
    .min(9, 'Account number must be at least 9 digits')
    .max(18, 'Account number must be at most 18 digits')
    .regex(/^\d+$/, 'Account number must contain only digits'),
  ifsc: IfscValidator,
  accountType: z.enum(['savings', 'current', 'salary']),
  uan: z
    .string()
    .regex(/^\d{12}$/, 'UAN must be a 12-digit number')
    .optional()
    .or(z.literal('')),
  esic: z
    .string()
    .regex(/^\d{17}$/, 'ESIC number must be 17 digits')
    .optional()
    .or(z.literal('')),
});

// ─── Inferred Types ───────────────────────────────────────────────────────────

export type InviteEmployeeDto = z.infer<typeof InviteEmployeeSchema>;
export type OnboardingStep1Dto = z.infer<typeof OnboardingStep1Schema>;
export type OnboardingStep2Dto = z.infer<typeof OnboardingStep2Schema>;
export type OnboardingStep3Dto = z.infer<typeof OnboardingStep3Schema>;
export type OnboardingStep4Dto = z.infer<typeof OnboardingStep4Schema>;
