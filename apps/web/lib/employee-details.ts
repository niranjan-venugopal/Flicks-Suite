// Shared validation for employee statutory/identity fields — used by the
// self-onboarding wizard AND the admin "Edit personal & statutory" dialog so
// the two paths can never drift.
export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const
export const MARITAL_STATUSES = ['single', 'married', 'divorced', 'widowed'] as const
export const GENDERS = ['male', 'female', 'other', 'prefer_not_to_say'] as const
export const BANK_ACCOUNT_TYPES = ['savings', 'current', 'salary'] as const
