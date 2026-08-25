// Shared validation for employee statutory/identity fields — used by the
// self-onboarding wizard AND the admin "Edit personal & statutory" dialog so
// the two paths can never drift.
export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const
export const MARITAL_STATUSES = ['single', 'married', 'divorced', 'widowed'] as const
export const GENDERS = ['male', 'female', 'other', 'prefer_not_to_say'] as const
export const BANK_ACCOUNT_TYPES = ['savings', 'current', 'salary'] as const

// Major scheduled Indian banks (public + private sector), alphabetized, with
// "Other" last — picking Other opens a free-text field, and the typed name is
// what gets stored in the single bankName column (the API takes free text).
export const OTHER_BANK = 'Other'
export const BANKS = [
  'Axis Bank',
  'Bandhan Bank',
  'Bank of Baroda',
  'Bank of India',
  'Bank of Maharashtra',
  'Canara Bank',
  'Central Bank of India',
  'City Union Bank',
  'CSB Bank',
  'DCB Bank',
  'Federal Bank',
  'HDFC Bank',
  'ICICI Bank',
  'IDBI Bank',
  'IDFC First Bank',
  'Indian Bank',
  'Indian Overseas Bank',
  'IndusInd Bank',
  'Jammu & Kashmir Bank',
  'Karnataka Bank',
  'Karur Vysya Bank',
  'Kotak Mahindra Bank',
  'Punjab & Sind Bank',
  'Punjab National Bank',
  'RBL Bank',
  'South Indian Bank',
  'State Bank of India',
  'Tamilnad Mercantile Bank',
  'UCO Bank',
  'Union Bank of India',
  'Yes Bank',
  OTHER_BANK,
] as const
